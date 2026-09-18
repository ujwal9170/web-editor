import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportQueue } from "../lib/exportQueue.mjs";
import { cropGeometry, exportTimeline, frameTimes } from "../shared/export.mjs";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("normalized full frames keep source proportions when cropped at 720p and 1080p", () => {
  for (const outputWidth of [720, 1080]) {
    for (const [sourceWidth, sourceHeight] of [
      [1080, 1920],
      [1920, 1080],
      [720, 1280],
      [1080, 1080],
    ]) {
      const outputHeight = (outputWidth * 16) / 9;
      const scale = Math.min(
        1,
        outputWidth / sourceWidth,
        outputHeight / sourceHeight,
      );
      const frameWidth = Math.round(sourceWidth * scale);
      const frameHeight = Math.round((frameWidth * sourceHeight) / sourceWidth);
      for (const crop of [
        { x: 0, y: 0, width: 1, height: 1 },
        { x: 0, y: 0.3, width: 1, height: 0.4 },
        { x: 0.2, y: 0.15, width: 0.6, height: 0.7 },
      ]) {
        const g = cropGeometry(
          crop,
          frameWidth,
          frameHeight,
          outputWidth,
          outputHeight,
        );
        // Both axes have the same scale (up to the two-pixel rounding budget).
        assert.ok(
          Math.abs(g.drawWidth / g.width - g.drawHeight / g.height) < 0.02,
        );
        assert.ok(g.left + g.width <= frameWidth);
        assert.ok(g.top + g.height <= frameHeight);
        const fullScale = Math.min(
          outputWidth / frameWidth,
          outputHeight / frameHeight,
        );
        assert.ok(Math.abs(g.drawHeight - g.height * fullScale) < 2.01);
      }
    }
  }
});
test("device crop follows latest stable-window positioning at both resolutions", () => {
  for (const width of [720, 1080]) {
    const height = (width * 16) / 9;
    const full = cropGeometry(
      { x: 0, y: 0, width: 1, height: 1 },
      1920,
      1080,
      width,
      height,
    );
    const left = cropGeometry(
      { x: 0.25, y: 0, width: 0.75, height: 1 },
      1920,
      1080,
      width,
      height,
    );
    assert.equal(left.drawX + left.drawWidth, full.drawX + full.drawWidth);
    assert.equal(left.drawY, full.drawY);
    assert.equal(left.drawHeight, full.drawHeight);
  }
});
test("cuts share one output frame grid and never include the removed middle", () => {
  const { ranges, duration } = exportTimeline([
    { startMs: 0, endMs: 2000, enabled: true },
    { startMs: 2000, endMs: 4000, enabled: false },
    { startMs: 4000, endMs: 6000, enabled: true },
  ]);
  const times = [...frameTimes(ranges, duration)];
  assert.equal(times.length, 120);
  assert.equal(times[60].sourceTime, 4);
  assert.ok(times.every((t) => t.sourceTime < 2 || t.sourceTime >= 4));
});

test("exports use immutable snapshots and execute strictly serially", async () => {
  const started = [],
    release = [];
  const queue = createExportQueue(async (task) => {
    started.push(task.project.name);
    await new Promise((r) => release.push(r));
    return task.project.name;
  });
  const task = { project: { name: "First" }, quality: "720p" };
  queue.add(task);
  task.project.name = "Changed later";
  queue.add({ project: { name: "Second" }, quality: "1080p" });
  assert.deepEqual(started, ["First"]);
  release.shift()();
  await tick();
  assert.deepEqual(started, ["First", "Second"]);
  release.shift()();
  await tick();
  assert.deepEqual(
    queue.list().map((r) => r.result),
    ["First", "Second"],
  );
});
test("cancel queued work and terminate current work before starting next", async () => {
  const started = [];
  const queue = createExportQueue(async (task, { signal }) => {
    started.push(task.project.name);
    if (task.project.name === "First")
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason)),
      );
  });
  const first = queue.add({ project: { name: "First" } });
  const second = queue.add({ project: { name: "Second" } });
  queue.add({ project: { name: "Third" } });
  queue.cancel(second);
  queue.cancel(first);
  await tick();
  assert.deepEqual(started, ["First", "Third"]);
  assert.deepEqual(
    queue.list().map((r) => r.status),
    ["cancelled", "cancelled", "done"],
  );
});
test("failure does not block next job and saving cannot be cancelled", async () => {
  let finish;
  const queue = createExportQueue(async (task, control) => {
    if (task.project.name === "Broken") throw new Error("Unsupported codec");
    control.saving();
    await new Promise((r) => (finish = r));
  });
  queue.add({ project: { name: "Broken" } });
  const id = queue.add({ project: { name: "Good" } });
  await tick();
  assert.equal(queue.list()[0].status, "failed");
  assert.equal(queue.cancel(id), false);
  finish();
  await tick();
  assert.equal(queue.list()[1].status, "done");
});
test("sign-out clears tasks and prevents old work starting queued tasks", async () => {
  let count = 0;
  const queue = createExportQueue(async (_, { signal }) => {
    count++;
    await new Promise((_, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason)),
    );
  });
  queue.add({ project: { name: "One" } });
  queue.add({ project: { name: "Two" } });
  queue.clear();
  await tick();
  assert.equal(count, 1);
  assert.deepEqual(queue.list(), []);
});
