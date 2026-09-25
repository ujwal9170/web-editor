import test from "node:test";
import assert from "node:assert/strict";
import {
  SAFE_ZONE,
  MAX_TEXT_Y,
  textPositionLimits,
  clampTextPosition,
} from "../shared/safe-zone.mjs";

// A caption's own box, as a fraction of the 1080x1920 canvas. Roughly what one
// line at the default size measures.
const line = { width: 0.4, height: 0.05 };

test("the reserved top band is deep enough for the platforms' own chrome", () => {
  // Instagram, TikTok and YouTube all draw over the first eighth of a vertical
  // video. Anything shallower than this and a caption ends up behind it.
  assert.ok(
    SAFE_ZONE.top >= 0.12 && SAFE_ZONE.top <= 0.14,
    `top band is ${SAFE_ZONE.top}`,
  );
});

test("text cannot be placed in the top band, whichever way it is moved", () => {
  const limits = textPositionLimits(line);
  // The limit is on the block's rendered footprint, not its anchor: half the
  // block sits above the centre point.
  assert.equal(limits.minY, SAFE_ZONE.top + line.height / 2);
  for (const attempt of [0, 0.01, 0.05, SAFE_ZONE.top, -3]) {
    const { y } = clampTextPosition(0.5, attempt, line);
    assert.ok(y >= limits.minY, `y ${y} entered the band from ${attempt}`);
    // The top of the block itself, not just its centre, clears the band.
    assert.ok(y - line.height / 2 >= SAFE_ZONE.top - 1e-9);
  }
  assert.equal(clampTextPosition(0.5, 0.5, line).y, 0.5);
});

test("growing a block pushes it down rather than letting it fill the band", () => {
  // Typing more words, a bigger size or a wider font all grow the box. The
  // same clamp runs on every change, so a block that was legal at one line is
  // moved down instead of creeping up into the band as it gets taller.
  const small = clampTextPosition(0.5, 0.16, { width: 0.4, height: 0.05 });
  const grown = clampTextPosition(0.5, small.y, { width: 0.4, height: 0.2 });
  assert.ok(grown.y > small.y);
  assert.ok(grown.y - 0.1 >= SAFE_ZONE.top - 1e-9);
});

test("a block too tall for the usable area still clears the top band", () => {
  // Its floor and its ceiling cross over. The floor has to win: overhanging
  // the bottom is survivable, disappearing under the platform's UI is not.
  const huge = { width: 1.4, height: 1.6 };
  const limits = textPositionLimits(huge);
  assert.ok(limits.maxY >= limits.minY);
  for (const attempt of [0, 0.5, 1]) {
    const { x, y } = clampTextPosition(attempt, attempt, huge);
    assert.equal(y, limits.minY);
    assert.equal(x, limits.minX);
  }
});

test("the side bands and the bottom are held to the same rule", () => {
  const limits = textPositionLimits(line);
  assert.equal(limits.minX, SAFE_ZONE.left + line.width / 2);
  assert.equal(limits.maxX, 1 - SAFE_ZONE.right - line.width / 2);
  assert.equal(clampTextPosition(0, 0.5, line).x, limits.minX);
  assert.equal(clampTextPosition(1, 0.5, line).x, limits.maxX);
  assert.equal(clampTextPosition(0.5, 1, line).y, MAX_TEXT_Y);
  // Every clamped position is one the sliders can also reach, so the two
  // controls cannot disagree about where text may sit.
  for (const [x, y] of [
    [0, 0],
    [1, 1],
    [0.5, 0.5],
  ]) {
    const p = clampTextPosition(x, y, line);
    assert.ok(p.x >= limits.minX && p.x <= limits.maxX);
    assert.ok(p.y >= limits.minY && p.y <= limits.maxY);
  }
});
