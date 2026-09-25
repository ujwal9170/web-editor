// Where a text overlay is allowed to sit on the finished 9:16 frame, shared by
// the preview's wrap, the drag on the canvas and the position sliders. One
// definition on purpose: if the clamp and the width text wraps at disagreed, a
// line would wrap at a boundary it could then be dragged past.
//
// The top band is deliberately much deeper than the sides. Instagram, TikTok
// and YouTube all stack their own chrome -- profile row, sound pill, the
// status bar above them -- down the first eighth of a vertical video, and a
// caption that starts at 7% ends up underneath it. 13% clears all three with a
// little room to spare.
export const SAFE_ZONE = { top: 0.13, left: 0.07, right: 0.07 };
// The lowest a text block's centre may sit: text dragged flush to the bottom
// edge lands under the platforms' own caption row.
export const MAX_TEXT_Y = 0.9;
// Where a text block of this measured size (canvas fractions) may have its
// centre. Half the box is added on each side, so the block's rendered
// footprint stays out of the bands rather than merely its anchor point.
export function textPositionLimits(box) {
  const minX = SAFE_ZONE.left + box.width / 2,
    minY = SAFE_ZONE.top + box.height / 2;
  return {
    minX,
    minY,
    // A block wider or taller than the usable area would invert these; the
    // floor wins, so such text overhangs the bottom and the right rather than
    // the top, which is the band that actually matters.
    maxX: Math.max(minX, 1 - SAFE_ZONE.right - box.width / 2),
    maxY: Math.max(minY, MAX_TEXT_Y),
  };
}
// The single rule about where text may sit. The drag, the position sliders and
// every other edit that changes a block's size all run through this, so no
// route into an edit can leave a caption in a band the drag refuses to enter.
export function clampTextPosition(x, y, box) {
  const limits = textPositionLimits(box);
  return {
    x: Math.min(limits.maxX, Math.max(limits.minX, x)),
    y: Math.min(limits.maxY, Math.max(limits.minY, y)),
  };
}
