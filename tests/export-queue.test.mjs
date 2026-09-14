import { test } from "node:test";
import assert from "node:assert/strict";
import { createExportQueue } from "../lib/exportQueue.mjs";
import { cropGeometry, exportTimeline, frameTimes } from "../shared/export.mjs";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
test("a crop always covers the canvas exactly, at both resolutions", () => {
  for (const width of [720, 1080]) {
    const height = (width * 16) / 9;
    const full = cropGeometry(
      { x: 0, y: 0, width: 1, height: 1, panX: 0.5, panY: 0.5 },
      1920,
      1080,
      width,
      height,
    );
    const narrow = cropGeometry(
      { x: 0.25, y: 0, width: 0.5, height: 1, panX: 0.5, panY: 0.5 },
      1920,
      1080,
      width,
      height,
    );
    // A crop never leaves any background showing through it -- the visible
    // window always draws edge-to-edge, whatever the selection.
    for (const g of [full, narrow]) {
      assert.equal(g.drawX, 0);
      assert.equal(g.drawY, 0);
      assert.equal(g.drawWidth, width);
      assert.equal(g.drawHeight, height);
    }
    // The default (untouched) selection already covers a 16:9 source into
    // this 9:16 canvas by cropping its width down -- horizontal slack to
    // pan through, none vertically.
    assert.ok(full.width < 1920);
    assert.equal(full.height, 1080);
    // An explicit, narrower crop covers just the remainder -- its visible
    // window can never reach outside the selected half.
    assert.ok(narrow.left >= 1920 * 0.25 - 1);
    assert.ok(narrow.left + narrow.width <= 1920 * 0.75 + 1);
  }
});
test("panning slides the visible window through a crop's overflow, not past it", () => {
  const width = 1080,
    height = 1920;
  const centered = cropGeometry(
    { x: 0, y: 0, width: 1, height: 1, panX: 0.5, panY: 0.5 },
    1920,
    1080,
    width,
    height,
  );
  const atStart = cropGeometry(
    { x: 0, y: 0, width: 1, height: 1, panX: 0, panY: 0.5 },
    1920,
    1080,
    width,
    height,
  );
  const atEnd = cropGeometry(
    { x: 0, y: 0, width: 1, height: 1, panX: 1, panY: 0.5 },
    1920,
    1080,
    width,
    height,
  );
  assert.equal(atStart.left, 0);
  assert.equal(atEnd.left + atEnd.width, 1920);
  assert.ok(centered.left > atStart.left && centered.left < atEnd.left);
  // Only the axis with overflow moves -- this source fills height exactly,
  // so panY has nothing to slide through.
  assert.equal(atStart.top, centered.top);
  assert.equal(atStart.height, centered.height);
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
