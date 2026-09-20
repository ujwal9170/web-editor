import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRepository } from "../server/repository.mjs";
import { createApp } from "../server/app.mjs";
import { createUser, setPassword } from "../server/users.mjs";
import { initialEdit } from "../shared/validation.mjs";
async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "frame-access-export-"));
  const repo = createRepository(root),
    submitted = [];
  const user = await createUser(repo, "employee", "employee-password");
  const app = await createApp({
    dataDir: root,
    queueFactory: () => ({
      add(type, payload, done) {
        submitted.push({ type, payload, done });
        return { id: crypto.randomUUID(), status: "queued" };
      },
    }),
  });
  const login = (username = "employee", password = "employee-password") =>
    app.inject({
      method: "POST",
      url: "/api/auth",
      payload: { username, password },
    });
  const response = await login();
  const cookie = response.headers["set-cookie"].split(";")[0];
  const request = (url, method = "GET", payload, headers = {}) =>
    app.inject({ url, method, payload, headers: { cookie, ...headers } });
  t.after(async () => {
    await app.close();
    repo.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, user, app, login, request, submitted };
}
test("15 successful logins through one proxy are allowed; failed attempts isolated by account", async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 15; i++) assert.equal((await f.login()).statusCode, 200);
  for (let i = 0; i < 8; i++)
    assert.equal((await f.login("employee", "wrong")).statusCode, 401);
  assert.equal((await f.login()).statusCode, 429);
  await createUser(f.repo, "another", "another-password");
  assert.equal((await f.login("another", "another-password")).statusCode, 200);
});
test("CLI account deletion and password change revoke already logged-in sessions", async (t) => {
  const f = await fixture(t);
  await setPassword(f.repo, "employee", "new-password");
  assert.equal((await f.request("/api/media")).statusCode, 401);
  const loggedIn = await f.login("employee", "new-password");
  const cookie = loggedIn.headers["set-cookie"].split(";")[0];
  f.repo.remove("user", f.user.id);
  assert.equal(
    (await f.request("/api/auth", "GET", undefined, { cookie })).json()
      .authenticated,
    false,
  );
  assert.equal(
    (await f.request("/api/media", "GET", undefined, { cookie })).statusCode,
    401,
  );
});
test("snapshot export survives later edits, remains private, and never invokes a server render", async (t) => {
  const f = await fixture(t);
  writeFileSync(path.join(f.root, "source.mp4"), "test-only");
  const media = f.repo.put("media", {
    userId: f.user.id,
    name: "Source",
    status: "ready",
    file: "source.mp4",
    duration: 6,
  });
  const project = f.repo.put("project", {
    userId: f.user.id,
    mediaId: media.id,
    name: "Original title",
    caption: "Original caption",
    edit: initialEdit(6000),
    revision: 1,
  });
  const base = `/api/projects/${project.id}/renders`;
  assert.equal((await f.request(base, "POST", {})).statusCode, 410);
  const prepared = await f.request(`${base}/device/prepare`, "POST", {
    revision: 1,
    quality: "720p",
  });
  assert.equal(prepared.statusCode, 200);
  const { ticketId } = prepared.json();
  const stranger = await createUser(f.repo, "stranger", "stranger-password");
  const login = await f.login(stranger.username, "stranger-password");
  assert.equal(
    (
      await f.request(`/api/device-exports/${ticketId}`, "DELETE", undefined, {
        cookie: login.headers["set-cookie"].split(";")[0],
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.request(`/api/projects/${project.id}`, "DELETE")).statusCode,
    409,
  );
  f.repo.put("project", {
    ...project,
    caption: "Changed while rendering",
    name: "New title",
    revision: 2,
  });
  const multipart =
    '--frame\r\nContent-Disposition: form-data; name="file"; filename="export.mp4"\r\nContent-Type: video/mp4\r\n\r\ntest-video\r\n--frame--\r\n';
  const accepted = await f.request(
    `${base}/device?ticketId=${ticketId}`,
    "POST",
    multipart,
    { "content-type": "multipart/form-data; boundary=frame" },
  );
  assert.equal(accepted.statusCode, 202, accepted.body);
  assert.equal(f.submitted.length, 1);
  assert.equal(f.submitted[0].type, "accept");
  assert.equal(f.submitted[0].payload.quality, "720p");
  await f.submitted[0].done({
    file: "finished.mp4",
    duration: 6,
    width: 720,
    height: 1280,
  });
  const output = f.repo.list("export")[0];
  assert.equal(output.caption, "Original caption");
  assert.equal(output.name, "Original title");
  assert.equal(
    (
      await f.request(
        `${base}/device?ticketId=${ticketId}`,
        "POST",
        multipart,
        { "content-type": "multipart/form-data; boundary=frame" },
      )
    ).statusCode,
    404,
  );
});
