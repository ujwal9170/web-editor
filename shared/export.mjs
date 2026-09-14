// Export resolution is independent of the edit's canonical 1080-wide canvas.
export function exportProfile(resolution = 720) {
  if (![720, 1080].includes(resolution))
    throw new Error("Choose 720p or 1080p.");
  return {
    width: resolution,
    height: resolution === 720 ? 1280 : 1920,
    fps: 30,
    bitrate: resolution === 720 ? 4_000_000 : 8_000_000,
  };
}

export function exportTimeline(segments) {
  let duration = 0;
  const ranges = segments
    .filter((s) => s.enabled)
    .map((s) => {
      const start = s.startMs / 1000,
        end = s.endMs / 1000;
      const range = { start, end, outputStart: duration };
      duration += end - start;
      return range;
    });
  return { ranges, duration };
}

// A single output frame grid avoids accumulating rounding errors at cuts.
export function* frameTimes(ranges, duration, fps = 30) {
  let segment = 0;
  for (let frame = 0; frame < Math.ceil(duration * fps - 1e-7); frame++) {
    const outputTime = frame / fps;
    while (
      segment + 1 < ranges.length &&
      outputTime >= ranges[segment + 1].outputStart - 1e-9
    )
      segment++;
    const range = ranges[segment];
    yield {
      outputTime,
      sourceTime: range.start + outputTime - range.outputStart,
      duration: Math.min(1 / fps, duration - outputTime),
    };
  }
}

// The crop actually discards everything outside the selection: what's left
// is scaled to cover the canvas completely, like a standard photo/video
// crop-and-position tool -- a crop never leaves background showing through
// it. Panning (panX/panY, each 0..1, 0.5 = centered) then slides the
// visible window through whatever overflow that cover-scale leaves on one
// axis (cover-fit always leaves slack on at most one of the two axes).
// Mirrors lib/canvas.ts's compose() and worker/media.py's render() exactly,
// so preview, on-device export and the server render all agree
// pixel-for-pixel.
export function cropGeometry(crop, sourceWidth, sourceHeight, width, height) {
  const sw = Math.max(2, Math.floor((sourceWidth * crop.width) / 2) * 2);
  const sh = Math.max(2, Math.floor((sourceHeight * crop.height) / 2) * 2);
  const cropLeft = Math.max(
    0,
    Math.min(sourceWidth - sw, Math.floor((sourceWidth * crop.x) / 2) * 2),
  );
  const cropTop = Math.max(
    0,
    Math.min(sourceHeight - sh, Math.floor((sourceHeight * crop.y) / 2) * 2),
  );
  const scale = Math.max(width / sw, height / sh);
  const visibleWidth = Math.min(sw, Math.round(width / scale / 2) * 2);
  const visibleHeight = Math.min(sh, Math.round(height / scale / 2) * 2);
  const panX = crop.panX ?? 0.5,
    panY = crop.panY ?? 0.5;
  const left =
    cropLeft + Math.round(((sw - visibleWidth) * panX) / 2) * 2;
  const top =
    cropTop + Math.round(((sh - visibleHeight) * panY) / 2) * 2;
  return {
    left,
    top,
    width: visibleWidth,
    height: visibleHeight,
    drawX: 0,
    drawY: 0,
    drawWidth: width,
    drawHeight: height,
  };
}
