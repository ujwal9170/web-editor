import { test } from "node:test";
import assert from "node:assert/strict";
import { exportQueueLabel } from "../shared/mobile-ui.mjs";
test("failed/cancelled exports are not labelled successful", () => {
  assert.equal(exportQueueLabel([{status: "failed"}]), "Failed");
  assert.equal(exportQueueLabel([{status: "done"}, {status: "failed"}]), "Failed");
  assert.equal(exportQueueLabel([{status: "cancelled"}]), "Cancelled");
  assert.equal(exportQueueLabel([{status: "done"}]), "Finished");
  assert.equal(exportQueueLabel([{status: "failed"}, {status: "running"}, {status: "saving"}]), "2 pending");
});
