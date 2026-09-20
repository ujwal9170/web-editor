import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  initialEdit,
  validateEdit,
  validateTemplate,
  editFromTemplate,
  instagramUrl,
  videoLink,
} from "../shared/validation.mjs";
import { createRepository } from "../server/repository.mjs";
import { createApp } from "../server/app.mjs";
import { createUser } from "../server/users.mjs";

// Every API route now requires an account, so tests that exercise routes sign
// in first and send the session cookie with each request.
async function authorize(app, root, username = "tester") {
  const repo = createRepository(root);
  await createUser(repo, username, "test-password-123");
  repo.close();
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
import "../public/audio/dsp.js";

test("URL normalization rejects non-Instagram and credential-bearing URLs", () => {
  assert.equal(
    instagramUrl("https://instagram.com/reel/ABC_123/?igsh=123"),
    "https://www.instagram.com/reel/ABC_123/",
  );
  for (const url of [
    "http://instagram.com/reel/ABC123/",
    "https://instagram.com.evil.test/reel/ABC123/",
    "https://user:pass@instagram.com/reel/ABC123/",
    "https://instagram.com:4430/reel/ABC123/",
    "file:///etc/passwd",
    "https://instagram.com/accounts/login/",
  ])
    assert.throws(() => instagramUrl(url));
});
test("video links normalize supported platforms without accepting arbitrary URLs", () => {
  for (const url of [
    "https://youtu.be/BaW_jenozKc?si=tracking",
    "https://m.youtube.com/watch?v=BaW_jenozKc&list=ignored&t=5",
    "https://www.youtube.com/shorts/BaW_jenozKc",
    "https://youtube.com/embed/BaW_jenozKc",
  ])
    assert.deepEqual(videoLink(url), {
      source: "youtube",
      label: "YouTube",
      url: "https://www.youtube.com/watch?v=BaW_jenozKc",
    });
  for (const url of [
    "https://www.tiktok.com/@creator/video/1234567890123456789?is_from_webapp=1",
    "https://vm.tiktok.com/ZM123456/",
    "https://vt.tiktok.com/ZM123456/",
    "https://www.tiktok.com/t/ZM123456/",
  ])
    assert.equal(videoLink(url).source, "tiktok");
  assert.equal(
    videoLink(" https://instagram.com/reel/ABC123/?igsh=test ").source,
    "instagram",
  );
  for (const url of [
    "https://youtube.com.evil.test/watch?v=BaW_jenozKc",
    "https://tiktok.com@127.0.0.1/@user/video/1234567890123456789",
    "http://youtu.be/BaW_jenozKc",
    "https://youtube.com:444/watch?v=BaW_jenozKc",
    "https://youtube.com/playlist?list=abc",
    "https://youtube.com/watch?v=short",
    "https://youtube.com/watch?v=BaW_jenozKc&v=BaW_jenozKc",
    "https://tiktok.com/@creator",
    "https://www.tiktok.com/@creator/live",
    "https://vm.tiktok.com/redirect/extra?url=http://localhost",
    "https://127.0.0.1/video.mp4",
  ])
    assert.throws(() => videoLink(url));
});

test("download API routes all three sources to the same import queue", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-links-"));
  const queued = [];
  const app = await createApp({
    dataDir: root,
    queueFactory: () => ({
      add(type, payload) {
        queued.push(payload);
        return { id: "test-job", type, status: "queued" };
      },
    }),
  });
  const inject = await authorize(app, root);
  try {
    for (const [source, url] of [
      ["instagram", "https://instagram.com/reel/ABC123/"],
      ["youtube", "https://youtu.be/BaW_jenozKc"],
      ["tiktok", "https://vm.tiktok.com/ZM123456/"],
    ]) {
      assert.equal(
        (
          await inject({
            method: "POST",
            url: "/api/downloads",
            payload: { url },
          })
        ).statusCode,
        400,
      );
      const response = await inject({
        method: "POST",
        url: "/api/downloads",
        payload: { url, confirmed: true },
      });
      assert.equal(response.statusCode, 202);
      assert.equal(response.json().media.source, source);
      assert.equal(queued.at(-1).platform, source);
      assert.equal(queued.at(-1).url, videoLink(url).url);
    }
    assert.equal((await inject("/api/media")).json().length, 3);
  } finally {
    await app.close();
    rmSync(root, { recursive: true });
  }
});

test("a blur region is optional, bounded, and survives a round trip", () => {
  const edit = initialEdit(10000);
  // Edits saved before blur existed carry no such key at all; they have to
  // keep validating rather than being rejected as malformed.
  const { blur, ...withoutBlur } = edit;
  assert.equal(validateEdit(withoutBlur, 10000).blur, null);
  const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.25, intensity: 60 };
  assert.deepEqual(validateEdit({ ...edit, blur: region }, 10000).blur, region);
  for (const bad of [
    { ...region, x: 0.8, width: 0.5 },
    { ...region, y: 0.9, height: 0.5 },
    { ...region, width: 0 },
    { ...region, intensity: 0 },
    { ...region, intensity: 101 },
  ])
    assert.throws(() => validateEdit({ ...edit, blur: bad }, 10000));
});
test("a blur covers the whole clip and outlives a swap to a shorter one", () => {
  const region = { x: 0.1, y: 0.2, width: 0.5, height: 0.25, intensity: 60 };
  const edit = { ...initialEdit(10000), blur: region };
  // It carries no startMs/endMs of its own, unlike a text overlay -- there is
  // no window it could fall outside of, so it is on every frame by
  // construction rather than by being re-spanned.
  assert.deepEqual(Object.keys(region).sort(), [
    "height",
    "intensity",
    "width",
    "x",
    "y",
  ]);
  // Replacing the source clip re-spans text against the new duration; the
  // blur needs no such treatment, so a much shorter clip must still validate
  // with the region untouched.
  const swapped = {
    ...edit,
    segments: [{ startMs: 0, endMs: 2000, enabled: true }],
    textOverlays: [],
  };
  assert.deepEqual(validateEdit(swapped, 2000).blur, region);
});
test("an edit written with a font that no longer exists still opens", () => {
  // The Text tab dropped DM Sans, Montserrat and Roboto. A project saved with
  // one of them has to keep working -- rejecting it would lock the owner out
  // of their own edit -- so the font falls back instead.
  const base = initialEdit(10000);
  const overlay = {
    id: "old",
    text: "Saved last week",
    font: "Montserrat",
    color: "#FFFFFF",
    size: 56,
    x: 0.5,
    y: 0.5,
    startMs: 0,
    endMs: 10000,
  };
  const checked = validateEdit({ ...base, textOverlays: [overlay] }, 10000);
  assert.equal(checked.textOverlays[0].font, "Inter");
  // Nothing else about it is touched, and it keeps the weight it was drawn at
  // back when every overlay was bold.
  assert.equal(checked.textOverlays[0].text, "Saved last week");
  assert.equal(checked.textOverlays[0].bold, true);
  // A font that is still offered survives as itself, and Bold is remembered
  // in both positions.
  for (const [font, bold] of [
    ["Zilla Slab", false],
    ["Inter Medium", true],
    ["Rubik", false],
  ]) {
    const result = validateEdit(
      { ...base, textOverlays: [{ ...overlay, font, bold }] },
      10000,
    );
    assert.equal(result.textOverlays[0].font, font);
    assert.equal(result.textOverlays[0].bold, bold);
  }
});
test("edit validation rejects out-of-bounds crops, overlaps and an empty timeline", () => {
  const edit = initialEdit(10000);
  assert.deepEqual(validateEdit(edit, 10000), edit);
  for (const ratio of ["1:1", "4:5", "16:9"]) {
    assert.throws(() =>
      validateEdit(
        { ...edit, canvas: { ...edit.canvas, aspectRatio: ratio } },
        10000,
      ),
    );
  }
  assert.throws(() =>
    validateEdit(
      { ...edit, crop: { x: 0.9, y: 0, width: 0.5, height: 1 } },
      10000,
    ),
  );
  assert.throws(() =>
    validateEdit(
      {
        ...edit,
        segments: [
          { startMs: 0, endMs: 5000, enabled: true },
          { startMs: 4000, endMs: 10000, enabled: true },
        ],
      },
      10000,
    ),
  );
  assert.throws(() =>
    validateEdit(
      { ...edit, segments: [{ startMs: 0, endMs: 10000, enabled: false }] },
      10000,
    ),
  );
});
test("a template carries crop/background/text but never timing or audio", () => {
  const edit = {
    ...initialEdit(10000),
    crop: { x: 0.1, y: 0.2, width: 0.6, height: 0.5, offsetX: 0.3 },
    textOverlays: [
      {
        id: "a",
        text: "hi",
        font: "Inter",
        color: "#FFFFFF",
        size: 40,
        x: 0.5,
        y: 0.1,
        startMs: 1000,
        endMs: 4000,
      },
    ],
  };
  // A template is only the reusable subset -- passing the full edit
  // (segments/audio included) still validates, since those extra keys are
  // simply not part of the schema and get stripped, not rejected.
  const templateEdit = validateTemplate({
    canvas: edit.canvas,
    crop: edit.crop,
    textOverlays: edit.textOverlays.map(
      ({ startMs, endMs, ...rest }) => rest,
    ),
  });
  assert.equal(templateEdit.textOverlays[0].startMs, undefined);
  assert.deepEqual(templateEdit.crop, edit.crop);

  const applied = editFromTemplate(templateEdit, 8000);
  assert.deepEqual(applied.crop, edit.crop);
  assert.deepEqual(applied.segments, [
    { startMs: 0, endMs: 8000, enabled: true },
  ]);
  assert.equal(applied.textOverlays[0].startMs, 0);
  assert.equal(applied.textOverlays[0].endMs, 8000);
  assert.equal(applied.audio.mode, "original");
  // The result is itself a valid, fully-formed edit for the new duration.
  assert.deepEqual(validateEdit(applied, 8000), applied);
});
test("repository persists records across restarts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-test-"));
  let repo = createRepository(root);
  const item = repo.put("project", {
    name: "saved caption",
    caption: "Hinglish test",
  });
  repo.close();
  repo = createRepository(root);
  assert.equal(repo.get("project", item.id).caption, "Hinglish test");
  repo.close();
  rmSync(root, { recursive: true });
});
test("API rejects cross-site mutation, invalid downloads, and unknown assets", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-api-"));
  const app = await createApp({ dataDir: root });
  const inject = await authorize(app, root);
  try {
    assert.equal(
      (
        await inject({
          method: "POST",
          url: "/api/downloads",
          headers: { origin: "https://evil.test" },
          payload: {
            url: "https://instagram.com/reel/ABC123",
            confirmed: true,
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await inject({
          method: "POST",
          url: "/api/downloads",
          payload: { url: "https://example.com" },
        })
      ).statusCode,
      400,
    );
    assert.equal((await inject("/api/media")).statusCode, 200);
    assert.equal(
      (
        await inject(
          "/api/files/media/00000000-0000-4000-8000-000000000000/file",
        )
      ).statusCode,
      404,
    );
    assert.equal(
      (await inject("/api/files/media/../../workspace.sqlite/file"))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true });
  }
});
test("accounts gate the API and issue an HttpOnly session", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-auth-"));
  const repo = createRepository(root);
  await createUser(repo, "alice", "alice-password");
  repo.close();
  const app = await createApp({ dataDir: root });
  try {
    assert.equal((await app.inject("/api/media")).statusCode, 401);
    for (const payload of [
      { username: "alice", password: "wrong" },
      { username: "nobody", password: "alice-password" },
    ])
      assert.equal(
        (await app.inject({ method: "POST", url: "/api/auth", payload }))
          .statusCode,
        401,
      );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth",
      payload: { username: "alice", password: "alice-password" },
    });
    assert.match(login.headers["set-cookie"], /HttpOnly/);
    const cookie = login.headers["set-cookie"].split(";")[0];
    assert.equal((await app.inject({ url: "/api/media", headers: { cookie } })).statusCode, 200);
    await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    assert.equal((await app.inject({ url: "/api/media", headers: { cookie } })).statusCode, 401);
  } finally {
    await app.close();
    rmSync(root, { recursive: true });
  }
});
test("one account cannot see, open or download another account's work", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-isolation-"));
  const repo = createRepository(root);
  await createUser(repo, "alice", "alice-password");
  await createUser(repo, "bob", "bob-password");
  // Alice owns a ready media item; Bob owns nothing.
  const owned = repo.put("media", {
    userId: repo.list("user").find((u) => u.username === "alice").id,
    name: "alice clip",
    caption: "private",
    source: "upload",
    status: "ready",
    duration: 6,
    file: "alice.mp4",
    thumbnail: "alice.jpg",
  });
  repo.close();
  const app = await createApp({ dataDir: root });
  const signIn = async (username, password) => {
    const r = await app.inject({
      method: "POST",
      url: "/api/auth",
      payload: { username, password },
    });
    return r.headers["set-cookie"].split(";")[0];
  };
  try {
    const alice = await signIn("alice", "alice-password");
    const bob = await signIn("bob", "bob-password");

    assert.equal(
      JSON.parse((await app.inject({ url: "/api/media", headers: { cookie: alice } })).body).length,
      1,
      "owner sees their own media",
    );
    assert.deepEqual(
      JSON.parse((await app.inject({ url: "/api/media", headers: { cookie: bob } })).body),
      [],
      "another account sees an empty library",
    );
    // Knowing the id must not be enough: records and their bytes are both
    // refused, and with 404 so the id's existence stays hidden.
    for (const url of [
      `/api/files/media/${owned.id}/file`,
      `/api/files/media/${owned.id}/caption`,
    ])
      assert.equal(
        (await app.inject({ url, headers: { cookie: bob } })).statusCode,
        404,
        `${url} must not serve another account's data`,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects",
          headers: { cookie: bob },
          payload: { mediaId: owned.id },
        })
      ).statusCode,
      404,
      "another account cannot start an edit from media they do not own",
    );
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/media/${owned.id}`,
          headers: { cookie: bob },
        })
      ).statusCode,
      404,
      "another account cannot delete media they do not own",
    );
    // And the owner is unaffected by all of that.
    assert.equal(
      (await app.inject({ url: `/api/files/media/${owned.id}/caption`, headers: { cookie: alice } })).body,
      "private",
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true });
  }
});
test("admin routes manage accounts only, and members cannot reach them", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-admin-"));
  const repo = createRepository(root);
  const boss = await createUser(repo, "boss", "boss-password", "admin");
  await createUser(repo, "member", "member-password");
  // Content belonging to the member, so removal choices can be checked.
  repo.put("media", {
    userId: repo.list("user").find((u) => u.username === "member").id,
    name: "member clip",
    status: "ready",
    size: 1234,
    file: "member.mp4",
  });
  repo.close();
  const app = await createApp({ dataDir: root });
  const signIn = async (username, password) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/auth",
        payload: { username, password },
      })
    ).headers["set-cookie"].split(";")[0];
  try {
    const admin = await signIn("boss", "boss-password");
    const member = await signIn("member", "member-password");

    // A plain member is refused everywhere in /api/admin.
    for (const [method, url] of [
      ["GET", "/api/admin/users"],
      ["POST", "/api/admin/users"],
    ])
      assert.equal(
        (
          await app.inject({
            method,
            url,
            headers: { cookie: member },
            payload: { username: "sneaky", password: "sneaky-password" },
          })
        ).statusCode,
        403,
        `${url} must be admin-only`,
      );

    const listed = JSON.parse(
      (await app.inject({ url: "/api/admin/users", headers: { cookie: admin } }))
        .body,
    );
    assert.equal(listed.length, 2);
    const target = listed.find((u) => u.username === "member");
    assert.equal(target.mediaCount, 1, "admin sees counts");
    assert.equal(target.storageBytes, 1234, "admin sees storage totals");
    assert.ok(!("file" in target), "but never the media itself");

    // Accounts created through the web are always plain members.
    await app.inject({
      method: "POST",
      url: "/api/admin/users",
      headers: { cookie: admin },
      payload: { username: "newbie", password: "newbie-password" },
    });
    const afterAdd = JSON.parse(
      (await app.inject({ url: "/api/admin/users", headers: { cookie: admin } }))
        .body,
    );
    assert.equal(afterAdd.find((u) => u.username === "newbie").role, "member");

    // An admin cannot delete themselves, or the only admin account.
    assert.equal(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/admin/users/${boss.id}`,
          headers: { cookie: admin },
        })
      ).statusCode,
      409,
    );

    // Removing without deleteContent keeps the member's records.
    const removal = await app.inject({
      method: "DELETE",
      url: `/api/admin/users/${target.id}?deleteContent=false`,
      headers: { cookie: admin },
    });
    assert.equal(removal.statusCode, 200);
    assert.equal(removal.json().removedRecords, 0);
    const check = createRepository(root);
    assert.equal(check.list("media").length, 1, "their files were kept");
    assert.equal(check.list("user").length, 2, "the account is gone");
    check.close();
  } finally {
    await app.close();
    rmSync(root, { recursive: true });
  }
});
test("7680-point FFT roundtrip recovers non-power-of-two input", () => {
  const d = globalThis.AudioDSP,
    n = d.N,
    input = Float64Array.from(
      { length: n },
      (_, i) => Math.sin(i * 0.13) + Math.cos(i * 0.071),
    );
  const real = new Float64Array(n),
    imag = new Float64Array(n),
    result = new Float64Array(n),
    ri = new Float64Array(n);
  const p = d.plan(n);
  d.transform(p, input, new Float64Array(n), 0, 1, real, imag, 0, false);
  d.transform(p, real, imag, 0, 1, result, ri, 0, true);
  assert.ok(result.every((x, i) => Math.abs(x / n - input[i]) < 1e-9));
});
test("STFT/ISTFT preserves stereo low-frequency signal and sample alignment", () => {
  const d = globalThis.AudioDSP,
    l = Float32Array.from(
      { length: d.CHUNK },
      (_, i) => Math.sin((2 * Math.PI * 440 * i) / 44100) * 0.4,
    ),
    r = Float32Array.from(l, (x) => -x * 0.5);
  const [vl, vr] = d.istft(d.stft(l, r));
  let squared = 0;
  for (let i = 4000; i < l.length - 4000; i++) {
    squared += (vl[i] - l[i]) ** 2;
    assert.ok(Math.abs(vr[i] + vl[i] * 0.5) < 1e-6);
  }
  assert.ok(Math.sqrt(squared / (l.length - 8000)) < 0.0001);
  const wav = new DataView(d.wav(vl, vr));
  assert.equal(wav.getUint32(24, true), 44100);
  assert.equal(wav.getUint16(22, true), 2);
});

test("legacy server-render requests cannot enqueue a CPU render", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "frame-render-"));
  const queued = [];
  const repo = createRepository(root);
  const owner = await createUser(repo, "renderer", "test-password-123");
  const media = repo.put("media", {
    userId: owner.id,
    name: "clip",
    caption: "",
    status: "ready",
    duration: 6,
    width: 1280,
    height: 720,
    file: "source.mp4",
  });
  writeFileSync(path.join(root, "source.mp4"), "fixture");
  const edit = initialEdit(6000);
  const overlay = {
    font: "Inter",
    color: "#FFFFFF",
    size: 56,
    x: 0.5,
    y: 0.15,
  };
  edit.textOverlays = [
    { ...overlay, id: "a", text: "Hello", startMs: 0, endMs: 2000 },
    { ...overlay, id: "b", text: "   ", startMs: 1000, endMs: 6000 },
  ];
  const project = repo.put("project", {
    userId: owner.id,
    mediaId: media.id,
    name: "clip edit",
    caption: "",
    revision: 1,
    edit,
  });
  const app = await createApp({
    dataDir: root,
    queueFactory: () => ({
      add(type, payload) {
        queued.push(payload);
        return { id: "test-job", type, status: "queued" };
      },
    }),
  });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth",
    payload: { username: "renderer", password: "test-password-123" },
  });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const inject = (options) => app.inject({ ...options, headers: { cookie } });
  const png = "data:image/png;base64," + Buffer.from("png").toString("base64");
  const render = (overlays) =>
    inject({
      method: "POST",
      url: `/api/projects/${project.id}/renders`,
      payload: { revision: 1, background: png, overlays },
    });
  try {
    const response = await render([
      { png, x: 240, y: 280 },
      { png: null, x: 0, y: 0 },
    ]);
    assert.equal(response.statusCode, 410);
    assert.equal(queued.length, 0);
  } finally {
    await app.close();
    repo.close();
    rmSync(root, { recursive: true, force: true });
  }
});
