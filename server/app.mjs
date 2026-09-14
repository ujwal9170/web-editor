import Fastify from "fastify";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { createRepository } from "./repository.mjs";
import { createQueue } from "./jobs.mjs";
import {
  MEMBER,
  admins,
  authenticate,
  createUser,
  hasUsers,
  isAdmin,
  listUsers,
  setPassword,
} from "./users.mjs";
import { videoLink, initialEdit, validateEdit } from "../shared/validation.mjs";
import { cleanVideoName } from "../shared/names.mjs";

export async function createApp({
  dataDir = process.env.DATA_DIR || "runtime",
  logger = false,
  queueFactory = createQueue,
} = {}) {
  const root = path.resolve(dataDir);
  await mkdir(root, { recursive: true });
  const repo = createRepository(root),
    queue = queueFactory(repo, root);
  for (const kind of ["media", "project", "export"]) {
    for (const item of repo.list(kind)) {
      const name = cleanVideoName(item.name);
      if (name && name !== item.name)
        repo.put(kind, {
          ...item,
          name,
          ...(kind === "project" ? { revision: item.revision + 1 } : {}),
        });
    }
  }
  // Protect the async upload/artwork preparation window before a job is queued.
  const preparingProjects = new Map();
  const projectOperation = (handler) => async (req, reply) => {
    const id = req.params.id;
    preparingProjects.set(id, (preparingProjects.get(id) || 0) + 1);
    try {
      return await handler(req, reply);
    } finally {
      const count = preparingProjects.get(id) - 1;
      if (count) preparingProjects.set(id, count);
      else preparingProjects.delete(id);
    }
  };
  // One-time migration for development projects saved before Reel-only canvases.
  for (const project of repo.list("project")) {
    if (project.edit?.canvas?.aspectRatio !== "9:16") {
      project.edit.canvas.aspectRatio = "9:16";
      repo.put("project", { ...project, revision: project.revision + 1 });
    }
  }
  const app = Fastify({ logger, bodyLimit: 24 * 1024 * 1024 });
  const ttl =
    Math.max(1, Number(process.env.SOURCE_RETENTION_DAYS) || 7) * 86400_000;
  // One-time migration: exports made before auto-expiry existed get a fresh
  // retention window starting now, rather than being exempt forever.
  for (const item of repo.list("export"))
    if (!item.expiresAt)
      repo.put("export", { ...item, expiresAt: Date.now() + ttl });
  const sessions = new Map(),
    attempts = new Map();
  let authenticating = 0;
  // Record kinds that belong to exactly one account. Anything listed here is
  // filtered on read and ownership-checked on fetch.
  const OWNED = ["media", "project", "export", "audio", "job", "deviceExport"];
  const host = process.env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host) && !hasUsers(repo))
    throw new Error(
      "No accounts exist yet. Create one with `pnpm user add <username>` before serving on a non-loopback address.",
    );
  await app.register(multipart, {
    limits: { fileSize: 300 * 1024 * 1024, files: 1, fields: 4 },
  });
  await app.register(staticPlugin, { root, serve: false });
  app.addHook("onRequest", async (req, reply) => {
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Cache-Control", "no-store");
    const origin = req.headers.origin;
    const allowed = [
      process.env.PUBLIC_ORIGIN || "http://localhost:4174",
      "http://127.0.0.1:4174",
    ];
    if (origin && !allowed.includes(origin))
      return reply.code(403).send({ error: "Origin not allowed" });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["sec-fetch-site"] === "cross-site"
    )
      return reply.code(403).send({ error: "Cross-site request rejected" });
    if (req.url.startsWith("/api/auth") || req.url === "/api/health") return;
    const session = currentSession(req);
    if (!session)
      return reply.code(401).send({ error: "Sign in to the workspace." });
    // Every downstream handler scopes its data to this id.
    req.userId = session.userId;
    req.session = session;
    touch(session);
  });
  app.setErrorHandler((err, req, reply) => {
    reply.code(err.statusCode || (err instanceof z.ZodError ? 400 : 400)).send({
      error: err instanceof z.ZodError ? err.issues[0].message : err.message,
    });
  });
  const ONLINE_WINDOW = 5 * 60_000;
  const PRESENCE_WRITE_INTERVAL = 60_000;
  // Presence lives in memory and is only written to disk about once a minute per
  // user, so a busy session doesn't turn every request into a database write.
  // The persisted value is what survives a restart.
  function touch(session) {
    const now = Date.now();
    session.lastSeen = now;
    if (now - (session.persistedAt ?? 0) < PRESENCE_WRITE_INTERVAL) return;
    session.persistedAt = now;
    const user = repo.get("user", session.userId);
    if (user) repo.put("user", { ...user, lastSeenAt: now });
  }
  function lastSeenFor(userId) {
    let latest = repo.get("user", userId)?.lastSeenAt ?? 0;
    for (const session of sessions.values())
      if (session.userId === userId && session.expires > Date.now())
        latest = Math.max(latest, session.lastSeen ?? 0);
    return latest || null;
  }
  function requireAdmin(req) {
    const user = repo.get("user", req.userId);
    if (!isAdmin(user))
      throw Object.assign(new Error("Admins only."), { statusCode: 403 });
    return user;
  }
  function sessionToken(req) {
    return /(?:^|;\s*)studio_session=([^;]+)/.exec(
      req.headers.cookie || "",
    )?.[1];
  }
  function currentSession(req) {
    const token = sessionToken(req);
    if (!token) return null;
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) return null;
    const user = repo.get("user", session.userId);
    if (!user || user.hash !== session.authVersion) {
      sessions.delete(token);
      return null;
    }
    return session;
  }
  // Ownership is enforced here rather than per-route, so anything that reads a
  // record by id is covered -- including /api/files, where a missed check would
  // hand another user's video out to anyone holding the id. Unowned records
  // answer 404 rather than 403 so they don't confirm someone else's id exists.
  function get(kind, id, req) {
    const item = repo.get(kind, z.string().uuid().parse(id));
    const missing = () =>
      Object.assign(new Error("Not found"), { statusCode: 404 });
    if (!item) throw missing();
    if (OWNED.includes(kind) && item.userId !== req?.userId) throw missing();
    return item;
  }
  function mine(kind, req) {
    return repo.list(kind).filter((item) => item.userId === req.userId);
  }
  function mediaReady(id, req) {
    const item = get("media", id, req);
    if (item.status !== "ready" || !existsSync(path.join(root, item.file)))
      throw new Error("Source is unavailable or expired.");
    return item;
  }
  app.get("/api/health", () => ({
    ok: true,
    phase: "development",
    storage: "sqlite-local",
  }));
  const cookieFlags = `HttpOnly; SameSite=Strict; Path=/${
    process.env.PUBLIC_ORIGIN?.startsWith("https:") ? "; Secure" : ""
  }`;
  app.get("/api/auth", (req) => {
    const session = currentSession(req);
    return {
      authenticated: Boolean(session),
      username: session?.username ?? null,
      role: session ? (repo.get("user", session.userId)?.role ?? MEMBER) : null,
    };
  });
  app.post("/api/auth", async (req, reply) => {
    const credentials = z
      .object({
        username: z.string().trim().min(3).max(32),
        password: z.string().max(200),
      })
      .parse(req.body);
    // Next proxies every employee through loopback. Do not trust a client-supplied
    // forwarded IP, or count successful team logins against that shared address.
    const key = credentials.username.toLowerCase();
    const a = attempts.get(key) || {
      count: 0,
      pending: 0,
      until: Date.now() + 60_000,
    };
    if (a.until < Date.now()) {
      a.count = 0;
      a.until = Date.now() + 60_000;
    }
    if (a.count + a.pending >= 8 || authenticating >= 32)
      return reply.code(429).send({ error: "Try again in a minute." });
    if (!attempts.has(key) && attempts.size >= 10_000)
      return reply.code(429).send({ error: "Try again in a minute." });
    attempts.set(key, a);
    a.pending++;
    authenticating++;
    let user;
    try {
      user = await authenticate(
        repo,
        credentials.username,
        credentials.password,
      );
      if (!user) a.count++;
      else a.count = 0;
    } finally {
      a.pending--;
      authenticating--;
    }
    // One message for both cases: don't reveal which usernames exist.
    if (!user)
      return reply.code(401).send({ error: "Incorrect username or password." });
    const token = randomBytes(32).toString("hex");
    sessions.set(token, {
      userId: user.id,
      authVersion: user.hash,
      username: user.username,
      expires: Date.now() + 86400_000,
      lastSeen: Date.now(),
    });
    reply.header(
      "Set-Cookie",
      `studio_session=${token}; ${cookieFlags}; Max-Age=86400`,
    );
    return {
      authenticated: true,
      username: user.username,
      role: user.role ?? MEMBER,
    };
  });
  app.post("/api/auth/logout", (req, reply) => {
    const token = sessionToken(req);
    if (token) sessions.delete(token);
    reply.header("Set-Cookie", `studio_session=; ${cookieFlags}; Max-Age=0`);
    return { authenticated: false };
  });
  // --- Admin: accounts only. These routes deliberately expose counts and
  // storage totals but never the media itself, so "everything is private"
  // still holds for admins too.
  app.get("/api/admin/users", (req) => {
    requireAdmin(req);
    const now = Date.now();
    const totals = new Map();
    for (const kind of ["media", "export", "audio"])
      for (const item of repo.list(kind)) {
        const t = totals.get(item.userId) ?? { media: 0, exports: 0, bytes: 0 };
        if (kind === "media") t.media++;
        if (kind === "export") t.exports++;
        t.bytes += item.size ?? 0;
        totals.set(item.userId, t);
      }
    return listUsers(repo).map((u) => {
      const lastSeenAt = lastSeenFor(u.id);
      const t = totals.get(u.id) ?? { media: 0, exports: 0, bytes: 0 };
      return {
        ...u,
        lastSeenAt,
        online: Boolean(lastSeenAt && now - lastSeenAt < ONLINE_WINDOW),
        mediaCount: t.media,
        exportCount: t.exports,
        storageBytes: t.bytes,
        isSelf: u.id === req.userId,
      };
    });
  });
  app.post("/api/admin/users", async (req, reply) => {
    requireAdmin(req);
    const data = z
      .object({
        username: z.string().min(3).max(32),
        password: z.string().min(8).max(200),
      })
      .parse(req.body);
    // Always a plain member: admin rights are granted from the CLI only, so a
    // stolen admin session cannot mint more admins.
    const user = await createUser(repo, data.username, data.password, MEMBER);
    return reply.code(201).send({ id: user.id, username: user.username });
  });
  app.post("/api/admin/users/:id/password", async (req, reply) => {
    requireAdmin(req);
    const target = repo.get("user", z.string().uuid().parse(req.params.id));
    if (!target)
      throw Object.assign(new Error("Not found"), { statusCode: 404 });
    const { password } = z
      .object({ password: z.string().min(8).max(200) })
      .parse(req.body);
    await setPassword(repo, target.username, password);
    // Force them to sign in again everywhere with the new password.
    for (const [token, session] of sessions)
      if (session.userId === target.id) sessions.delete(token);
    return reply.send({ ok: true, username: target.username });
  });
  app.delete("/api/admin/users/:id", async (req) => {
    const actor = requireAdmin(req);
    const target = repo.get("user", z.string().uuid().parse(req.params.id));
    if (!target)
      throw Object.assign(new Error("Not found"), { statusCode: 404 });
    if (target.id === actor.id)
      throw Object.assign(new Error("You cannot remove your own account."), {
        statusCode: 409,
      });
    if (isAdmin(target) && admins(repo).length <= 1)
      throw Object.assign(new Error("That is the only admin account."), {
        statusCode: 409,
      });
    const deleteContent = req.query.deleteContent === "true";
    let removed = 0;
    if (deleteContent) {
      const owned = [];
      for (const kind of [
        "media",
        "project",
        "export",
        "audio",
        "job",
        "deviceExport",
      ])
        for (const item of repo.list(kind))
          if (item.userId === target.id) owned.push({ kind, ...item });
      removed = owned.length;
      await removeRecords(owned);
    }
    for (const [token, session] of sessions)
      if (session.userId === target.id) sessions.delete(token);
    repo.remove("user", target.id);
    return { ok: true, username: target.username, removedRecords: removed };
  });
  app.get("/api/media", (req) => mine("media", req));
  app.get("/api/jobs", (req) => mine("job", req).slice(0, 30));
  app.get("/api/jobs/:id", (req) => get("job", req.params.id, req));
  app.get("/api/projects", (req) => mine("project", req));
  app.get("/api/exports", (req) => mine("export", req));
  async function upload(req, extension) {
    const part = await req.file();
    if (!part) throw new Error("Choose a file.");
    const name = `${randomUUID()}${extension}`;
    const file = path.join(root, name);
    try {
      await pipeline(part.file, createWriteStream(file));
      if (part.file.truncated)
        throw new Error("File exceeds the 300 MB limit.");
    } catch (e) {
      await rm(file, { force: true });
      throw e;
    }
    return { name, originalName: part.filename.slice(0, 200) };
  }
  function importJob(item, payload) {
    return queue.add(
      "import",
      { ...payload, root, id: item.id, userId: item.userId },
      async (result) => {
        repo.put("media", {
          ...item,
          ...result,
          status: "ready",
          expiresAt: Date.now() + ttl,
        });
        return item.id;
      },
      async () => {
        repo.put("media", { ...item, status: "failed" });
        if (payload.input)
          await rm(path.join(root, payload.input), { force: true });
      },
    );
  }
  app.post("/api/media/uploads", async (req, reply) => {
    const file = await upload(req, ".upload");
    const media = repo.put("media", {
      userId: req.userId,
      name: file.originalName.replace(/\.[^.]+$/, ""),
      caption: "",
      source: "upload",
      status: "processing",
    });
    const job = importJob(media, { action: "import", input: file.name });
    return reply.code(202).send({ job, media });
  });
  app.post("/api/downloads", (req, reply) => {
    const { url, source, label } = videoLink(req.body?.url);
    if (req.body?.confirmed !== true)
      throw new Error("Confirm permission to use this video.");
    if (
      mine("job", req).filter((j) => ["queued", "running"].includes(j.status))
        .length >= 10
    )
      return reply.code(429).send({ error: "Queue is full. Please wait." });
    const media = repo.put("media", {
      userId: req.userId,
      name: `${label} video`,
      caption: "",
      source,
      sourceUrl: url,
      status: "processing",
    });
    const job = importJob(media, { action: "download", url, platform: source });
    return reply.code(202).send({ job, media });
  });
  app.patch("/api/media/:id", (req) => {
    const item = get("media", req.params.id, req);
    const data = z
      .object({
        name: z.string().min(1).max(200),
        caption: z.string().max(8000),
      })
      .parse(req.body);
    return repo.put("media", { ...item, ...data });
  });
  function isolating(id) {
    return repo
      .list("job")
      .some(
        (j) =>
          ["queued", "running"].includes(j.status) &&
          j.type === "isolate" &&
          j.mediaId === id,
      );
  }
  app.delete("/api/media/:id", async (req) => {
    const item = get("media", req.params.id, req);
    const linked = mine("project", req).filter((p) => p.mediaId === item.id);
    if (
      item.status === "processing" ||
      isolating(item.id) ||
      linked.some((p) => projectBusy(p.id))
    )
      throw Object.assign(
        new Error(
          "This video has processing in progress. Wait for it to finish before deleting.",
        ),
        { statusCode: 409 },
      );
    if (linked.length && req.query.deleteEdits !== "true")
      throw Object.assign(
        new Error(
          `This video has ${linked.length} saved edit(s). Confirm deletion of the video and linked edits, or delete those edits in Editor first. Exported videos will stay.`,
        ),
        { statusCode: 409 },
      );
    if (linked.length && Number(req.query.expectedEdits) !== linked.length)
      throw Object.assign(
        new Error(
          "The linked edits changed. Refresh the library and confirm deletion again.",
        ),
        { statusCode: 409 },
      );
    const records = [{ kind: "media", ...item }, ...editRecords(linked)];
    await removeRecords(records);
    return { ok: true, deletedEdits: linked.length };
  });
  app.post("/api/media/:id/vocal-isolation", async (req, reply) => {
    const item = mediaReady(req.params.id, req);
    const file = await upload(req, ".isolate-upload");
    const derived = repo.put("media", {
      userId: req.userId,
      name: `${item.name} · instruments removed`,
      caption: item.caption,
      source: "vocal-isolated",
      sourceMediaId: item.id,
      status: "processing",
    });
    const job = queue.add(
      "isolate",
      {
        action: "isolate",
        mediaId: item.id,
        userId: req.userId,
        root,
        input: item.file,
        audioFile: file.name,
        id: derived.id,
      },
      async (result) => {
        repo.put("media", {
          ...derived,
          ...result,
          status: "ready",
          expiresAt: Date.now() + ttl,
        });
        return derived.id;
      },
      async () => {
        repo.put("media", { ...derived, status: "failed" });
        await rm(path.join(root, file.name), { force: true });
      },
    );
    return reply.code(202).send({ job, media: derived });
  });
  function projectBusy(id) {
    return (
      preparingProjects.has(id) ||
      repo
        .list("deviceExport")
        .some((t) => t.projectId === id && t.expiresAt > Date.now()) ||
      repo
        .list("job")
        .some(
          (j) =>
            ["queued", "running"].includes(j.status) &&
            (j.projectId === id ||
              (!j.projectId && ["render", "audio"].includes(j.type))),
        )
    );
  }
  function editRecords(projects) {
    const ids = new Set(projects.map((p) => p.id));
    return [
      ...projects.map((p) => ({ kind: "project", ...p })),
      ...repo
        .list("audio")
        .filter((a) => ids.has(a.projectId))
        .map((a) => ({ kind: "audio", ...a })),
    ];
  }
  async function removeRecords(records) {
    // Remove references atomically before yielding; a stale autosave cannot recreate them.
    repo.removeMany(records);
    for (const item of records)
      for (const key of ["file", "audioFile", "thumbnail"]) {
        if (item[key])
          await rm(path.join(root, item[key]), { force: true }).catch(
            (error) => {
              // The record is deleted even if Windows temporarily holds a file open.
              app.log.warn(
                { error, file: item[key] },
                "Deferred orphan-file cleanup required",
              );
            },
          );
      }
  }
  app.delete("/api/projects/:id", async (req) => {
    const project = get("project", req.params.id, req);
    if (projectBusy(project.id))
      throw Object.assign(
        new Error(
          "This edit is processing. Wait for it to finish before deleting.",
        ),
        { statusCode: 409 },
      );
    await removeRecords(editRecords([project]));
    return { ok: true };
  });
  app.post("/api/projects", (req) => {
    const media = mediaReady(req.body?.mediaId, req);
    return repo.put("project", {
      userId: req.userId,
      mediaId: media.id,
      name: `${media.name} · edit`,
      caption: media.caption,
      edit: initialEdit(media.duration * 1000),
      revision: 1,
    });
  });
  app.get("/api/projects/:id", (req) => {
    const project = get("project", req.params.id, req);
    const media = mediaReady(project.mediaId, req);
    repo.put("media", { ...media, expiresAt: Date.now() + ttl });
    return { ...project, media };
  });
  app.patch("/api/projects/:id", (req) => {
    const item = get("project", req.params.id, req);
    const data = z
      .object({
        name: z.string().min(1).max(200),
        caption: z.string().max(8000),
        revision: z.number().int(),
        edit: z.unknown(),
        // Swaps which source this project edits, keeping the same edit
        // (crop/text/background/segments) applied to it. Optional: absent
        // means "same media as before."
        mediaId: z.string().optional(),
      })
      .parse(req.body);
    if (data.revision !== item.revision)
      throw Object.assign(
        new Error(
          "This project changed in another tab. Reopen it before saving.",
        ),
        { statusCode: 409 },
      );
    const media = mediaReady(data.mediaId ?? item.mediaId, req);
    const edit = validateEdit(data.edit, media.duration * 1000);
    if (edit.audio.derivativeId) {
      const a = get("audio", edit.audio.derivativeId, req);
      if (a.projectId !== item.id || a.status !== "ready")
        throw new Error("Audio is not ready for this project.");
    }
    const saved = repo.put("project", {
      ...item,
      ...data,
      mediaId: media.id,
      edit,
      revision: item.revision + 1,
    });
    return { ...saved, media };
  });
  app.post(
    "/api/projects/:id/audio",
    projectOperation(async (req, reply) => {
      const project = get("project", req.params.id, req),
        media = mediaReady(project.mediaId, req);
      const file = await upload(req, ".audio-upload");
      const audio = repo.put("audio", {
        userId: req.userId,
        projectId: project.id,
        status: "processing",
      });
      const job = queue.add(
        "audio",
        {
          action: "audio",
          projectId: project.id,
          mediaId: media.id,
          userId: req.userId,
          root,
          input: file.name,
          id: audio.id,
          duration: media.duration,
        },
        (result) => {
          repo.put("audio", { ...audio, ...result, status: "ready" });
          return audio.id;
        },
        () => rm(path.join(root, file.name), { force: true }),
      );
      return reply.code(202).send({ job });
    }),
  );
  // Rendering is device-only. Retire the old CPU-heavy endpoint explicitly.
  app.post("/api/projects/:id/renders", (req, reply) =>
    reply
      .code(410)
      .send({ error: "Server rendering is disabled. Export on this device." }),
  );
  app.post("/api/projects/:id/renders/device/prepare", (req) => {
    const project = get("project", req.params.id, req);
    const media = mediaReady(project.mediaId, req);
    const data = z
      .object({
        revision: z.number().int(),
        quality: z.enum(["720p", "1080p"]),
      })
      .parse(req.body);
    if (data.revision !== project.revision)
      throw new Error("Save the latest edit before exporting.");
    const spec = validateEdit(project.edit, media.duration * 1000);
    const duration =
      spec.segments
        .filter((s) => s.enabled)
        .reduce((n, s) => n + s.endMs - s.startMs, 0) / 1000;
    if (duration < 3) throw new Error("Keep at least 3 seconds for export.");
    if (["vocals-only", "remove-vocals"].includes(spec.audio.mode)) {
      const audio = get("audio", spec.audio.derivativeId, req);
      if (audio.projectId !== project.id || audio.status !== "ready")
        throw new Error("Apply processed audio first.");
    }
    if (
      mine("deviceExport", req).filter((t) => t.expiresAt > Date.now())
        .length >= 10
    )
      throw new Error(
        "Finish or cancel existing device exports first (maximum 10).",
      );
    // The immutable server-side snapshot survives subsequent autosaves. Never
    // trust a browser-supplied caption/edit to describe an unrelated MP4.
    const ticket = repo.put("deviceExport", {
      userId: req.userId,
      projectId: project.id,
      project: { ...project, edit: spec },
      quality: data.quality,
      duration,
      expiresAt: Date.now() + 24 * 3600_000,
      status: "pending",
    });
    return { ticketId: ticket.id };
  });
  app.delete("/api/device-exports/:id", (req, reply) => {
    const ticket = get("deviceExport", req.params.id, req);
    if (ticket.status !== "pending")
      return reply.code(409).send({ error: "Already saving the export." });
    repo.remove("deviceExport", ticket.id);
    return { ok: true };
  });
  app.post(
    "/api/projects/:id/renders/device",
    { bodyLimit: 320 * 1024 * 1024 },
    projectOperation(async (req, reply) => {
      const ticket = get("deviceExport", req.query.ticketId, req);
      if (
        ticket.projectId !== req.params.id ||
        ticket.expiresAt <= Date.now() ||
        ticket.status !== "pending"
      )
        throw new Error("Export snapshot unavailable. Queue the export again.");
      get("project", ticket.projectId, req);
      const project = ticket.project,
        spec = project.edit;
      const media = mediaReady(project.mediaId, req);
      // Claim before awaiting upload to reject duplicate submissions.
      repo.put("deviceExport", { ...ticket, status: "uploading" });
      let file;
      try {
        file = await upload(req, ".device-export");
        if (!currentSession(req))
          throw new Error("Account access was revoked.");
        const id = randomUUID();
        const job = queue.add(
          "accept",
          {
            action: "accept",
            projectId: project.id,
            mediaId: media.id,
            userId: req.userId,
            root,
            id,
            input: file.name,
            expectedDuration: ticket.duration,
            quality: ticket.quality,
          },
          async (result) => {
            if (!repo.get("user", req.userId)) {
              for (const key of ["file", "thumbnail"])
                if (result[key])
                  await rm(path.join(root, result[key]), { force: true });
              throw new Error("Account was removed.");
            }
            repo.put("export", {
              id,
              userId: req.userId,
              projectId: project.id,
              name: project.name,
              caption: project.caption,
              edit: spec,
              quality: ticket.quality,
              renderedOnDevice: true,
              expiresAt: Date.now() + ttl,
              ...result,
            });
            return id;
          },
          () => rm(path.join(root, file.name), { force: true }),
        );
        return reply.code(202).send({ job });
      } catch (error) {
        if (file) await rm(path.join(root, file.name), { force: true });
        throw error;
      } finally {
        repo.remove("deviceExport", ticket.id);
      }
    }),
  );
  async function deleteExport(item) {
    for (const key of ["file", "thumbnail"])
      if (item[key]) await rm(path.join(root, item[key]), { force: true });
    repo.remove("export", item.id);
  }
  app.delete("/api/exports/:id", async (req) => {
    const item = get("export", req.params.id, req);
    await deleteExport(item);
    return { ok: true };
  });
  app.get("/api/files/:kind/:id/:type", (req, reply) => {
    const { kind, id, type } = req.params;
    if (
      !["media", "export", "audio"].includes(kind) ||
      !["file", "thumbnail", "audioFile", "caption"].includes(type)
    )
      throw new Error("Invalid file route");
    const item = get(kind, id, req);
    if (type === "caption")
      return reply
        .type("text/plain; charset=utf-8")
        .header("Content-Disposition", 'attachment; filename="caption.txt"')
        .send(item.caption || "");
    if (!item[type] || !existsSync(path.join(root, item[type])))
      return reply.code(404).send({ error: "File unavailable" });
    if (req.query.download)
      reply.header(
        "Content-Disposition",
        `attachment; filename="${item.id}${path.extname(item[type])}"`,
      );
    return reply.sendFile(item[type], { cacheControl: false });
  });
  const cleaner = setInterval(async () => {
    for (const item of repo.list("media"))
      if (
        item.expiresAt < Date.now() &&
        item.status === "ready" &&
        !repo
          .list("deviceExport")
          .some(
            (t) => t.project.mediaId === item.id && t.expiresAt > Date.now(),
          ) &&
        !queue.busy
      ) {
        for (const key of ["file", "audioFile", "thumbnail"])
          if (item[key]) await rm(path.join(root, item[key]), { force: true });
        repo.put("media", { ...item, status: "expired" });
      }
    for (const item of repo.list("export"))
      if (item.expiresAt < Date.now() && !queue.busy) await deleteExport(item);
    for (const ticket of repo.list("deviceExport"))
      if (ticket.expiresAt <= Date.now())
        repo.remove("deviceExport", ticket.id);
    for (const [t, session] of sessions)
      if (session.expires < Date.now()) sessions.delete(t);
    for (const [ip, a] of attempts)
      if (a.until < Date.now() && !a.pending) attempts.delete(ip);
  }, 60_000);
  cleaner.unref();
  app.addHook("onClose", () => {
    clearInterval(cleaner);
    repo.close();
  });
  return app;
}
