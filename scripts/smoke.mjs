import { readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
const base = process.env.SMOKE_ORIGIN || "http://127.0.0.1:4174";
if (!process.env.SMOKE_USERNAME || !process.env.SMOKE_PASSWORD)
  throw new Error(
    "Set SMOKE_USERNAME and SMOKE_PASSWORD for an existing disposable QA account.",
  );
const login = await fetch(base + "/api/auth", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    username: process.env.SMOKE_USERNAME,
    password: process.env.SMOKE_PASSWORD,
  }),
});
if (!login.ok) throw new Error("QA account login failed.");
const cookie = login.headers.get("set-cookie").split(";")[0];
const python =
  process.env.PYTHON ||
  path.resolve(
    process.platform === "win32"
      ? ".venv/Scripts/python.exe"
      : ".venv/bin/python",
  );
await mkdir("work-test", { recursive: true });
const fixture = spawnSync(python, ["worker/fixture.py", "work-test"], {
  encoding: "utf8",
});
if (fixture.status) throw new Error(fixture.stderr);
async function api(route, opts = {}) {
  const r = await fetch(base + "/api" + route, {
    ...opts,
    headers: { ...opts.headers, cookie },
  });
  const body = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(body));
  return body;
}
async function wait(id) {
  for (let i = 0; i < 180; i++) {
    const j = await api("/jobs/" + id);
    if (j.status === "ready") return j;
    if (j.status === "failed") throw new Error(j.error);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("Job timed out");
}
const upload = new FormData();
upload.append(
  "file",
  new Blob([await readFile("work-test/QA-test-pattern.mp4")]),
  "QA-test-pattern.mp4",
);
const imported = await api("/media/uploads", { method: "POST", body: upload });
await wait(imported.job.id);
const media = (await api("/media")).find((m) => m.id === imported.media.id);
assert.equal(media.status, "ready");
assert.ok(Math.abs(media.duration - 6) < 0.2);
const stream = await fetch(base + `/api/files/media/${media.id}/file`, {
  headers: { Range: "bytes=0-99", cookie },
});
assert.equal(stream.status, 206);
const p = await api("/projects", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ mediaId: media.id }),
});
p.edit.canvas.aspectRatio = "9:16";
p.edit.canvas.background.colors = ["#7C3AED", "#7C3AED"];
p.edit.crop = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
p.edit.segments = [
  { startMs: 0, endMs: 2000, enabled: true },
  { startMs: 2000, endMs: 4000, enabled: false },
  { startMs: 4000, endMs: 6000, enabled: true },
];
p.edit.textOverlays = [
  {
    id: "qa",
    text: "QA",
    font: "Inter",
    size: 48,
    color: "#FFFFFF",
    x: 0.5,
    // Clear of the top band the editor reserves for platform chrome
    // (SAFE_ZONE in shared/safe-zone.mjs).
    y: 0.5,
    startMs: 0,
    endMs: 6000,
  },
];
// Two boxes, one timed and one for the whole clip, so the server render below
// exercises the blur chain rather than only crop/text/cuts.
p.edit.blur = [
  {
    id: "qa-face",
    x: 0.1,
    y: 0.15,
    width: 0.4,
    height: 0.2,
    intensity: 60,
    startMs: 0,
    endMs: 2000,
  },
  { id: "qa-logo", x: 0.6, y: 0.7, width: 0.3, height: 0.15, intensity: 25 },
];
const saved = await api(`/projects/${p.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "QA edited test pattern",
    caption: "Caption smoke test ✓",
    revision: p.revision,
    edit: p.edit,
  }),
});
const conflict = await fetch(base + `/api/projects/${p.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({
    name: p.name,
    caption: "",
    revision: p.revision,
    edit: p.edit,
  }),
});
assert.equal(conflict.status, 409);
for (const quality of ["720p", "1080p"]) {
  const { ticketId } = await api(`/projects/${p.id}/renders/device/prepare`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision: saved.revision, quality }),
  });
  await api(`/device-exports/${ticketId}`, { method: "DELETE" });
}
// A real server render, with the artwork the browser would normally draw
// standing in as the fixture's PNGs. This is the one path a Node script can
// exercise all the way to a finished MP4 -- on-device export needs codecs only
// a browser has.
const artwork = async (file) =>
  "data:image/png;base64," +
  (await readFile("work-test/" + file)).toString("base64");
const stale = await fetch(base + `/api/projects/${p.id}/renders`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie },
  body: JSON.stringify({
    revision: saved.revision - 1,
    background: await artwork("background.png"),
    overlays: [{ png: await artwork("overlay.png"), x: 0, y: 0 }],
  }),
});
assert.equal(stale.status, 400);
const rendering = await api(`/projects/${p.id}/renders`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    revision: saved.revision,
    quality: "1080p",
    background: await artwork("background.png"),
    overlays: [{ png: await artwork("overlay.png"), x: 0, y: 0 }],
  }),
});
assert.equal(rendering.job.type, "render");
const rendered = await wait(rendering.job.id);
const output = (await api("/exports")).find((x) => x.id === rendered.resultId);
assert.ok(output, "server render produced no export");
assert.equal(output.renderedOnDevice, false);
assert.equal(output.width, 1080);
assert.equal(output.height, 1920);
// The middle segment is disabled, so four of the six seconds survive.
assert.ok(Math.abs(output.duration - 4) < 0.3, `rendered ${output.duration}s`);
assert.equal(output.edit.blur.length, 2);
const playback = await fetch(base + `/api/files/export/${output.id}/file`, {
  headers: { Range: "bytes=0-99", cookie },
});
assert.equal(playback.status, 206);
console.log(
  JSON.stringify(
    {
      passed: true,
      mediaId: media.id,
      projectId: p.id,
      exportId: output.id,
      checks: [
        "authenticated upload",
        "normalize",
        "range playback",
        "revision conflict",
        "720p/1080p snapshots",
        "stale-revision render refused",
        "server render with two blur boxes",
        "rendered export plays back",
      ],
      next: "Open the QA edit in the browser. Export both resolutions on the device, navigate to another edit while rendering, and test Cancel. This Node script does not exercise browser codecs.",
    },
    null,
    2,
  ),
);
