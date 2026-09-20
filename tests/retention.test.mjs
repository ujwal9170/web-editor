import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRepository } from "../server/repository.mjs";
import { createUser } from "../server/users.mjs";
import { createApp } from "../server/app.mjs";
import { initialEdit } from "../shared/validation.mjs";

const HOUR = 3600_000;
const RETENTION = 36 * HOUR;
// Nothing in these tests may reach Python: the queue only has to exist.
const idleQueue = () => ({
  add: (type) => ({ id: "test-job", type, status: "queued" }),
  stats: () => ({ limit: 2, running: 0, waiting: 0 }),
  position: () => 0,
});

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), "frame-retention-"));
  const repo = createRepository(root);
  // Windows will not delete the directory while the app still holds the
  // SQLite file, and hooks run in the order they were added -- so this one
  // hook owns the whole teardown.
  const open = {};
  const file = (name, ageMs = 0) => {
    writeFileSync(path.join(root, name), "fixture");
    if (ageMs) {
      const when = (Date.now() - ageMs) / 1000;
      utimesSync(path.join(root, name), when, when);
    }
    return name;
  };
  t.after(async () => {
    await open.app?.close();
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    repo,
    file,
    async start(extra = {}) {
      open.app = await createApp({
        dataDir: root,
        queueFactory: idleQueue,
        ...extra,
      });
      return open.app;
    },
  };
}

async function signIn(app, repo, username = "keeper") {
  await createUser(repo, username, "test-password-123");
  const login = await app.inject({
    method: "POST",
    url: "/api/auth",
    payload: { username, password: "test-password-123" },
  });
  const cookie = login.headers["set-cookie"].split(";")[0];
  return (options) =>
    app.inject(
      typeof options === "string"
        ? { url: options, headers: { cookie } }
        : { ...options, headers: { ...options.headers, cookie } },
    );
}

test("a source is deleted 36 hours after import, with its thumbnail and stems", async (t) => {
  const w = workspace(t);
  const media = w.repo.put("media", {
    userId: "owner",
    name: "old clip",
    status: "ready",
    duration: 6,
    createdAt: Date.now() - 37 * HOUR,
    // Written under the old policy, which pushed the deadline out on every
    // open. The fixed window has to override it, not honour it.
    expiresAt: Date.now() + 5 * 86400_000,
    file: w.file("old.mp4"),
    thumbnail: w.file("old.jpg"),
    audioFile: w.file("old.wav"),
  });
  const project = w.repo.put("project", {
    userId: "owner",
    mediaId: media.id,
    name: "old edit",
    caption: "",
    revision: 1,
    edit: initialEdit(6000),
  });
  const stem = w.repo.put("audio", {
    userId: "owner",
    projectId: project.id,
    status: "ready",
    file: w.file("old-stem.wav"),
  });
  const keeper = w.repo.put("media", {
    userId: "owner",
    name: "fresh clip",
    status: "ready",
    duration: 6,
    createdAt: Date.now() - HOUR,
    file: w.file("fresh.mp4"),
  });
  await w.start();
  assert.equal(w.repo.get("media", media.id).status, "expired");
  for (const name of ["old.mp4", "old.jpg", "old.wav", "old-stem.wav"])
    assert.equal(existsSync(path.join(w.root, name)), false, name);
  assert.equal(w.repo.get("audio", stem.id), null);
  // The edit itself survives its source: it is small, and it says why it
  // stopped working.
  assert.ok(w.repo.get("project", project.id));
  assert.equal(w.repo.get("media", keeper.id).status, "ready");
  assert.equal(existsSync(path.join(w.root, "fresh.mp4")), true);
  assert.equal(
    w.repo.get("media", keeper.id).expiresAt,
    w.repo.get("media", keeper.id).createdAt + RETENTION,
  );
});

test("an export is deleted 36 hours after it was saved", async (t) => {
  const w = workspace(t);
  const stale = w.repo.put("export", {
    userId: "owner",
    name: "yesterday",
    createdAt: Date.now() - 40 * HOUR,
    file: w.file("stale.mp4"),
    thumbnail: w.file("stale.jpg"),
  });
  const recent = w.repo.put("export", {
    userId: "owner",
    name: "this morning",
    createdAt: Date.now() - 2 * HOUR,
    file: w.file("recent.mp4"),
  });
  await w.start();
  assert.equal(w.repo.get("export", stale.id), null);
  assert.equal(existsSync(path.join(w.root, "stale.mp4")), false);
  assert.equal(existsSync(path.join(w.root, "stale.jpg")), false);
  assert.equal(
    w.repo.get("export", recent.id).expiresAt,
    w.repo.get("export", recent.id).createdAt + RETENTION,
  );
  assert.equal(existsSync(path.join(w.root, "recent.mp4")), true);
});

test("opening a project does not push its source's deadline back", async (t) => {
  const w = workspace(t);
  const app = await w.start();
  const inject = await signIn(app, w.repo);
  const owner = w.repo.list("user")[0].id;
  const media = w.repo.put("media", {
    userId: owner,
    name: "clip",
    status: "ready",
    duration: 6,
    createdAt: Date.now() - 30 * HOUR,
    file: w.file("clip.mp4"),
  });
  const project = w.repo.put("project", {
    userId: owner,
    mediaId: media.id,
    name: "edit",
    caption: "",
    revision: 1,
    edit: initialEdit(6000),
  });
  const before = media.createdAt + RETENTION;
  w.repo.put("media", { ...media, expiresAt: before });
  for (let i = 0; i < 3; i++) {
    const response = await inject(`/api/projects/${project.id}`);
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().media.expiresAt, before);
  }
  assert.equal(w.repo.get("media", media.id).expiresAt, before);
  const limits = await inject("/api/limits");
  assert.equal(limits.json().retentionHours, 36);
});

test("uploads abandoned by a dead request are swept, fresh ones are left alone", async (t) => {
  const w = workspace(t);
  w.file("abandoned.upload", 7 * HOUR);
  w.file("abandoned.device-export", 7 * HOUR);
  w.file("in-flight.upload", 10 * 60_000);
  w.file("keep.mp4", 7 * HOUR);
  await w.start();
  assert.equal(existsSync(path.join(w.root, "abandoned.upload")), false);
  assert.equal(existsSync(path.join(w.root, "abandoned.device-export")), false);
  assert.equal(existsSync(path.join(w.root, "in-flight.upload")), true);
  // Only the recognisably temporary names are age-swept; a recorded file is
  // deleted by its record expiring, never by how old it looks on disk.
  assert.equal(existsSync(path.join(w.root, "keep.mp4")), true);
});

test("a source still being read by a job survives its deadline until the job ends", async (t) => {
  const w = workspace(t);
  const media = w.repo.put("media", {
    userId: "owner",
    name: "exporting",
    status: "ready",
    duration: 6,
    createdAt: Date.now() - 40 * HOUR,
    file: w.file("busy.mp4"),
  });
  w.repo.put("job", { type: "accept", status: "running", mediaId: media.id });
  await w.start();
  assert.equal(w.repo.get("media", media.id).status, "ready");
  assert.equal(existsSync(path.join(w.root, "busy.mp4")), true);
});
