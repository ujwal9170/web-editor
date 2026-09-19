import test from "node:test";
import assert from "node:assert/strict";
import { cropGeometry } from "../shared/export.mjs";
import { editSchema } from "../shared/validation.mjs";

test("pinch zoom preserves source crop and object centre at both export sizes", () => {
  for (const width of [720, 1080]) {
    const height = width * 16 / 9;
    const crop = { x: .1, y: .2, width: .8, height: .6, offsetX: .3, offsetY: .7 };
    const base = cropGeometry(crop, 1080, 1920, width, height);
    for (const zoom of [.25, .5, 1, 2, 4]) {
      const g = cropGeometry({ ...crop, zoom }, 1080, 1920, width, height);
      for (const key of ["left", "top", "width", "height"]) assert.equal(g[key], base[key]);
      assert.equal(g.drawWidth, base.drawWidth * zoom);
      assert.equal(g.drawHeight, base.drawHeight * zoom);
      assert.ok(Math.abs(g.drawX + g.drawWidth / 2 - base.drawX - base.drawWidth / 2) < 1e-8);
      assert.ok(Math.abs(g.drawY + g.drawHeight / 2 - base.drawY - base.drawHeight / 2) < 1e-8);
    }
  }
});

test("saved crop accepts bounded zoom and preserves old edits without a zoom field", () => {
  const crop = { x: 0, y: 0, width: 1, height: 1 };
  const schema = editSchema.shape.crop;
  assert.deepEqual(schema.parse(crop), crop);
  assert.equal(schema.parse({ ...crop, zoom: 2 }).zoom, 2);
  for (const zoom of [0, .24, 4.1, Infinity, NaN]) assert.equal(schema.safeParse({ ...crop, zoom }).success, false);
});
