import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createRepository } from "../server/repository.mjs";
import { createQueue, threadBudget } from "../server/jobs.mjs";
import { createUser } from "../server/users.mjs";
import { createApp } from "../server/app.mjs";
import { createStorage } from "../server/storage.mjs";
import {
  MODEL_PATH,
  MODEL_BYTES,
  ORT_DIR,
  ORT_FILES,
} from "../server/audio-assets.mjs";

// One teardown per test, registered before anything is opened: Windows
// refuses to delete a directory while the SQLite file inside it is still
// open, so everything has to close first, in reverse order.
function sandbox(t) {
  const dirs = [],
    closers = [];
  t.after(async () => {
    for (const close of closers.reverse()) await close();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir(prefix) {
      const root = mkdtempSync(path.join(tmpdir(), prefix));
      dirs.push(root);
      return root;
    },
    closing(closeable) {
      closers.push(() => closeable.close());
      return closeable;
    },
  };
}
// Stands in for the Python worker: a process that starts when the queue
// decides to run it and finishes only when a test says so.
function fakeSpawn(started) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    proc.finish = (result = { size: 1 }) => {
      proc.stdout.emit("data", Buffer.from(JSON.stringify(result)));
      proc.emit("close", 0);
    };
    started.push(proc);
    return proc;
  };
}
async function until(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("the server runs a fixed number of media jobs and queues the rest in order", async (t) => {
  const box = sandbox(t);
  const root = box.dir("frame-queue-");
  const repo = box.closing(createRepository(root));
  const started = [];
  const queue = createQueue(repo, root, {
    limit: 2,
    spawn: fakeSpawn(started),
  });
  const jobs = ["first", "second", "third", "fourth"].map((name) =>
    queue.add("import", { userId: "owner", input: name }, async () => name),
  );
  await until(() => started.length === 2, "the first two jobs to start");
  // The limit is the whole point: a third download does not get to compete
  // for the same CPU and disk as the two already running.
  assert.equal(started.length, 2);
  assert.equal(queue.stats().limit, 2);
  assert.equal(queue.stats().running, 2);
  assert.equal(queue.stats().waiting, 2);
  assert.equal(queue.position(jobs[2].id), 1);
  assert.equal(queue.position(jobs[3].id), 2);
  // A running job has no position; that is what separates "started" from
  // "next in line" on screen.
  assert.equal(queue.position(jobs[0].id), 0);
  assert.equal(repo.get("job", jobs[2].id).status, "queued");
  started[0].finish();
  await until(
    () => started.length === 3,
    "the third job to take the free slot",
  );
  assert.equal(queue.position(jobs[3].id), 1);
  assert.equal(queue.stats().waiting, 1);
  for (const proc of started.slice(1)) proc.finish();
  await until(() => started.length === 4, "the last job to start");
  started[3].finish();
  await until(() => queue.stats().running === 0, "the queue to drain");
  for (const job of jobs) assert.equal(repo.get("job", job.id).status, "ready");
});

test("only one video renders at a time, without holding up anything else", async (t) => {
  const box = sandbox(t);
  const root = box.dir("frame-render-queue-");
  const repo = box.closing(createRepository(root));
  const started = [];
  const queue = createQueue(repo, root, {
    limit: 2,
    spawn: fakeSpawn(started),
  });
  const first = queue.add("render", { userId: "owner" }, async () => "1");
  const second = queue.add("render", { userId: "owner" }, async () => "2");
  const download = queue.add("import", { userId: "owner" }, async () => "3");
  // Rendering pins its threads for minutes, so the second one waits -- but the
  // import behind it is stepped over rather than stuck behind the render, or
  // nobody could bring a clip in while someone else exports.
  await until(() => started.length === 2, "the render and the import to start");
  assert.equal(queue.stats().running, 2);
  assert.equal(repo.get("job", first.id).status, "running");
  assert.equal(repo.get("job", second.id).status, "queued");
  assert.equal(repo.get("job", download.id).status, "running");
  assert.equal(queue.position(second.id), 1);
  started[0].finish();
  await until(() => started.length === 3, "the second render to take its turn");
  assert.equal(repo.get("job", second.id).status, "running");
  for (const proc of started.slice(1)) proc.finish();
  await until(() => queue.stats().running === 0, "the queue to drain");
});

test("FFmpeg is given a share of the machine, not all of it", async (t) => {
  // The box serves the app as well as rendering on it. Every slot the queue
  // can fill comes out of the same allowance, so the ceiling holds however
  // many jobs happen to be running.
  const share = process.env.MEDIA_CPU_SHARE;
  delete process.env.MEDIA_CPU_SHARE;
  t.after(() => {
    if (share === undefined) delete process.env.MEDIA_CPU_SHARE;
    else process.env.MEDIA_CPU_SHARE = share;
  });
  for (const cores of [4, 8, 16, 32]) {
    // A render runs alone and gets the whole allowance -- the 70-80% of the
    // machine this ceiling is for.
    const render = threadBudget(1, cores);
    assert.ok(render <= cores * 0.8, render + " threads of " + cores + " cores");
    assert.ok(render >= cores * 0.6, render + " threads of " + cores + " cores");
    // The lighter jobs run two at a time and split the same allowance.
    const total = threadBudget(2, cores) * 2;
    assert.ok(total <= cores * 0.8, total + " threads of " + cores + " cores");
    assert.ok(total >= cores * 0.5, total + " threads of " + cores + " cores");
  }
  // A machine too small to divide still gets a thread: FFmpeg cannot run on
  // less, and refusing to render at all would be worse than the overshoot.
  assert.equal(threadBudget(2, 1), 1);
  process.env.MEDIA_CPU_SHARE = "0.5";
  assert.equal(threadBudget(1, 8), 4);
  // The worker is told its allowance in the job file it reads, so it never has
  // to guess how many jobs are sharing the machine.
  const box = sandbox(t);
  const root = box.dir("frame-threads-");
  const repo = box.closing(createRepository(root));
  const started = [];
  const queue = createQueue(repo, root, {
    limit: 2,
    threads: 3,
    spawn: fakeSpawn(started),
  });
  const job = queue.add(
    "render",
    { action: "render", userId: "owner" },
    async () => "1",
  );
  await until(() => started.length === 1, "the render to start");
  const spec = JSON.parse(
    readFileSync(path.join(root, job.id + ".job.json"), "utf8"),
  );
  assert.equal(spec.threads, 3);
  assert.equal(spec.action, "render");
  assert.equal(queue.stats().threads, 3);
  started[0].finish();
  await until(() => queue.stats().running === 0, "the queue to drain");
  // The two allowances are separate, and the worker is handed the one that
  // matches the job in front of it rather than a single number for everything.
  const split = createQueue(repo, root, {
    limit: 2,
    threads: 2,
    renderThreads: 6,
    spawn: fakeSpawn(started),
  });
  const light = split.add("import", { action: "import" }, async () => "2");
  const heavy = split.add("render", { action: "render" }, async () => "3");
  await until(() => started.length === 3, "both jobs to start");
  const allowance = (id) =>
    JSON.parse(readFileSync(path.join(root, id + ".job.json"), "utf8")).threads;
  assert.equal(allowance(light.id), 2);
  assert.equal(allowance(heavy.id), 6);
  assert.equal(split.stats().renderThreads, 6);
  for (const proc of started.slice(1)) proc.finish();
  await until(() => split.stats().running === 0, "the split queue to drain");
});

test("a waiting job reports its place in line through the API", async (t) => {
  const box = sandbox(t);
  const root = box.dir("frame-queue-api-");
  const repo = box.closing(createRepository(root));
  await createUser(repo, "waiting", "test-password-123");
  const userId = repo.list("user")[0].id;
  const queued = repo.put("job", { type: "import", status: "queued", userId });
  const app = box.closing(
    await createApp({
      dataDir: root,
      queueFactory: () => ({
        add: (type) => ({ id: "x", type, status: "queued" }),
        stats: () => ({ limit: 2, running: 2, waiting: 3 }),
        position: (id) => (id === queued.id ? 3 : 0),
      }),
    }),
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/auth",
    payload: { username: "waiting", password: "test-password-123" },
  });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const job = (
    await app.inject({ url: `/api/jobs/${queued.id}`, headers: { cookie } })
  ).json();
  assert.equal(job.queuePosition, 3);
  assert.equal(job.queueLimit, 2);
  assert.equal(job.queueRunning, 2);
  assert.equal(job.queueWaiting, 3);
  const listed = (
    await app.inject({ url: "/api/jobs", headers: { cookie } })
  ).json();
  assert.equal(listed[0].queuePosition, 3);
});

test("storage status warns before it refuses, and refuses before the disk fills", async (t) => {
  const root = sandbox(t).dir("frame-storage-");
  const bytes = 4096;
  writeFileSync(path.join(root, "clip.mp4"), Buffer.alloc(bytes));
  const gb = 1024 ** 3;
  assert.equal(
    (await createStorage(root, { quotaGb: 1 }).status()).level,
    "ok",
  );
  assert.equal(
    (await createStorage(root, { quotaGb: bytes / gb / 0.85 }).status()).level,
    "warning",
  );
  const full = await createStorage(root, {
    quotaGb: bytes / gb / 0.99,
  }).status();
  assert.equal(full.level, "full");
  assert.match(full.message, /New imports are paused/);
  assert.equal(full.usedBytes, bytes);
});

test("a full disk pauses new imports without touching the rest of the workspace", async (t) => {
  const box = sandbox(t);
  const root = box.dir("frame-full-");
  const repo = box.closing(createRepository(root));
  await createUser(repo, "importer", "test-password-123");
  // Demand more free space than any disk has, so the guard trips whatever
  // machine the tests run on.
  const reserve = process.env.STORAGE_RESERVE_GB;
  process.env.STORAGE_RESERVE_GB = "1000000";
  t.after(() => {
    if (reserve === undefined) delete process.env.STORAGE_RESERVE_GB;
    else process.env.STORAGE_RESERVE_GB = reserve;
  });
  const app = box.closing(
    await createApp({
      dataDir: root,
      queueFactory: () => ({
        add: (type) => ({ id: "x", type, status: "queued" }),
      }),
    }),
  );
  const login = await app.inject({
    method: "POST",
    url: "/api/auth",
    payload: { username: "importer", password: "test-password-123" },
  });
  const cookie = login.headers["set-cookie"].split(";")[0];
  const inject = (options) =>
    app.inject(
      typeof options === "string"
        ? { url: options, headers: { cookie } }
        : { ...options, headers: { ...options.headers, cookie } },
    );
  assert.equal((await inject("/api/limits")).json().storage.level, "full");
  const download = await inject({
    method: "POST",
    url: "/api/downloads",
    payload: { url: "https://youtu.be/BaW_jenozKc", confirmed: true },
  });
  assert.equal(download.statusCode, 507);
  assert.match(download.json().error, /imports are paused/);
  const upload = await inject({ method: "POST", url: "/api/media/uploads" });
  assert.equal(upload.statusCode, 507);
  // Nothing was recorded for the refused import, and reading the workspace
  // still works: the safeguard stops intake, not the app.
  assert.equal(repo.list("media").length, 0);
  assert.equal((await inject("/api/media")).statusCode, 200);
  assert.equal((await inject("/api/exports")).statusCode, 200);
});

test("the API reports vocal removal as unavailable until the model is installed", async (t) => {
  const box = sandbox(t);
  const root = box.dir("frame-audio-");
  const project = box.dir("frame-audio-project-");
  const repo = box.closing(createRepository(root));
  await createUser(repo, "editor", "test-password-123");
  const start = async () => {
    const app = box.closing(
      await createApp({
        dataDir: root,
        projectRoot: project,
        queueFactory: () => ({ add: () => ({ id: "x" }) }),
      }),
    );
    const login = await app.inject({
      method: "POST",
      url: "/api/auth",
      payload: { username: "editor", password: "test-password-123" },
    });
    const cookie = login.headers["set-cookie"].split(";")[0];
    return {
      app,
      model: async () =>
        (
          await app.inject({ url: "/api/audio-model", headers: { cookie } })
        ).json(),
    };
  };
  const before = await start();
  const missing = await before.model();
  assert.equal(missing.available, false);
  assert.match(missing.detail, /setup:audio/);
  assert.ok(missing.missing.length >= ORT_FILES.length);
  // Install the assets the way `pnpm setup:audio` leaves them, then confirm
  // the same check passes: a server that ran setup must not go on telling the
  // editor the feature is unavailable.
  mkdirSync(path.join(project, path.dirname(MODEL_PATH)), { recursive: true });
  writeFileSync(path.join(project, MODEL_PATH), "");
  truncateSync(path.join(project, MODEL_PATH), MODEL_BYTES);
  mkdirSync(path.join(project, ORT_DIR), { recursive: true });
  for (const name of ORT_FILES)
    writeFileSync(path.join(project, ORT_DIR, name), "asset");
  const after = await start();
  const installed = await after.model();
  assert.deepEqual(installed.missing, []);
  assert.equal(installed.available, true);
});
