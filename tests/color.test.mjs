import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHex, colorGrid } from "../shared/color.mjs";
test("custom HEX accepts short/full pasted codes and rejects invalid colours", () => {
  assert.equal(normalizeHex(" #ffab01 "), "#FFAB01");
  assert.equal(normalizeHex("fa0"), "#FFAA00");
  for (const value of ["#", "ff", "12345", "gggggg", "12345678"]) assert.equal(normalizeHex(value), null);
});
test("grid provides unique valid colours including white and black", () => {
  const grid = colorGrid();
  assert.equal(grid.length, 48);
  assert.equal(new Set(grid).size, 48);
  assert.equal(grid[0], "#FFFFFF");
  assert.equal(grid[7], "#000000");
  assert.ok(grid.every(c => normalizeHex(c) === c));
});
