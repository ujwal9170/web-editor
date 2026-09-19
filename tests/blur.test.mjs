import test from "node:test";
import assert from "node:assert/strict";
import { blurPixels } from "../shared/blur.mjs";
test("software blur softens detail without making opaque footage transparent", () => {
  const pixels = new Uint8ClampedArray(40 * 4);
  for (let x = 0; x < 40; x++) pixels.set([x < 20 ? 0 : 255, 0, 0, 255], x * 4);
  const mild = blurPixels(pixels.slice(), 40, 1, 1);
  const strong = blurPixels(pixels.slice(), 40, 1, 5);
  assert.ok(strong[16 * 4] > mild[16 * 4]);
  for (let x = 0; x < 40; x++) assert.equal(strong[x * 4 + 3], 255);
});
test("tiny blur regions preserve solid colour and alpha", () => {
  assert.deepEqual([...blurPixels(new Uint8ClampedArray([80, 120, 200, 255]), 1, 1, 4)], [80, 120, 200, 255]);
});
