// Export resolution is independent of the edit's canonical 1080-wide canvas.
export function exportProfile(resolution = 720) {
  if (![720, 1080].includes(resolution))
    throw new Error("Choose 720p or 1080p.");
  return {
    width: resolution,
    height: resolution === 720 ? 1280 : 1920,
    fps: 30,
    // Not the target any more -- the export encodes to a constant quantizer
    // (see device-render.worker.ts), so this is the ceiling and the fallback
    // for encoders that can't do quantizer-driven encoding. 720p used to sit
    // at 4 Mbps, which starved a busy shot at 720x1280 and is why 720p looked
    // markedly worse than the same clip out of other editors; it now has room
    // to spend what a hard frame needs, while an easy one still costs little.
    bitrate: resolution === 720 ? 6_000_000 : 10_000_000,
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

// crop.x/y/width/height are a source-selection concern ONLY -- which pixels
// are kept, sized at a fixed scale (fitting the FULL, uncropped source) so
// cropping never itself zooms. Where the resulting rectangle draws on the
// canvas is a SEPARATE, independent concern: crop.offsetX/offsetY (0..1)
// position it anywhere across the full canvas -- not just within whatever
// room the crop selection's own source position happens to leave, which is
// what made dragging feel like it was fighting the crop sliders instead of
// freely moving an object. Left unset, offsetX/offsetY default to exactly
// the position cropping alone would have given it (the edge(s) not cropped
// stay put), so a fresh crop with no drag yet looks identical to before.
// Mirrors lib/canvas.ts's compose() and worker/media.py's render() exactly,
// so preview, on-device export and the server render all agree
// pixel-for-pixel.
export function cropGeometry(crop, sourceWidth, sourceHeight, width, height) {
  const sw = Math.max(2, Math.floor((sourceWidth * crop.width) / 2) * 2);
  const sh = Math.max(2, Math.floor((sourceHeight * crop.height) / 2) * 2);
  const left = Math.max(
    0,
    Math.min(sourceWidth - sw, Math.floor((sourceWidth * crop.x) / 2) * 2),
  );
  const top = Math.max(
    0,
    Math.min(sourceHeight - sh, Math.floor((sourceHeight * crop.y) / 2) * 2),
  );
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = Math.max(2, Math.floor((sw * scale) / 2) * 2);
  const drawHeight = Math.max(2, Math.floor((sh * scale) / 2) * 2);
  const pinnedX = (width - sourceWidth * scale) / 2 + left * scale;
  const pinnedY = (height - sourceHeight * scale) / 2 + top * scale;
  const availX = Math.max(0, width - drawWidth);
  const availY = Math.max(0, height - drawHeight);
  const defaultOffsetX = availX > 0 ? pinnedX / availX : 0.5;
  const defaultOffsetY = availY > 0 ? pinnedY / availY : 0.5;
  const offsetX = Math.min(1, Math.max(0, crop.offsetX ?? defaultOffsetX));
  const offsetY = Math.min(1, Math.max(0, crop.offsetY ?? defaultOffsetY));
  return {
    left,
    top,
    width: sw,
    height: sh,
    drawX: availX * offsetX,
    drawY: availY * offsetY,
    drawWidth,
    drawHeight,
  };
}
