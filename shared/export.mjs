// Export resolution is independent of the edit's canonical 1080-wide canvas.
// Marks the one failure the page can do something about rather than report:
// this browser's WebCodecs audio decoder refused the clip, so the page decodes
// the track itself and hands the export raw PCM instead. Matched as a
// substring of the worker's error, so it has to be distinctive.
export const AUDIO_DECODE_FAILED = "AUDIO_DECODE_FAILED";
export function exportProfile(resolution = 720) {
  if (![720, 1080].includes(resolution))
    throw new Error("Choose 720p or 1080p.");
  const small = resolution === 720;
  return {
    width: resolution,
    height: small ? 1280 : 1920,
    // A ceiling, not a target: the export picks its own frame rate from the
    // source and never exceeds this (see device-render.worker.ts).
    fps: 30,
    // The ceiling, and the target on any encoder without quantizer-driven
    // encoding -- which includes plenty of phones. Measured from this
    // workspace's own exports: the same edit came out at 2.8 Mbps from a
    // desktop (quantizer) and 9.6 Mbps from an Android phone, pinned to
    // whatever this number said. On those devices this value alone decides
    // the size, so it is set from the sweep below rather than by feel: 4.2
    // Mbps measured SSIM 0.9962 on this footage, so 4.5 leaves headroom for
    // a bitrate encoder being less efficient than a quantizer one.
    bitrate: small ? 3_500_000 : 4_500_000,
    // Lower means better. Chosen by sweeping this footage through x264 and
    // scoring each result against the source, rather than by taste:
    //
    //   crf 19  10.55 MB  SSIM 0.9962      crf 25  5.73 MB  SSIM 0.9943
    //   crf 21   8.52 MB  SSIM 0.9956      crf 27  4.80 MB  SSIM 0.9935
    //   crf 23   6.95 MB  SSIM 0.9950
    //
    // SSIM moves 0.27% across that whole range while the file halves and
    // halves again; anything above ~0.99 is indistinguishable in motion on a
    // phone, let alone after the re-encode every platform applies. 25 is the
    // knee -- a quarter of the size for a difference you cannot see. (A
    // keyframe every 2s vs every 5s was also measured: 1-2%, not worth the
    // seeking cost, so it stays where it was.)
    //
    // 720p sits tighter than 1080p because it has 44% of the pixels to spend
    // on, so the same quantizer would leave it looking softer for a file
    // that was already small.
    quantizer: small ? 22 : 25,
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

// Where each block of page-decoded PCM lands on the export timeline, when the
// browser's own audio decoder was no use (see AUDIO_DECODE_FAILED). Same cuts
// the video follows: each kept range is read from its own place in the source
// buffer and written at its place in the output, so a removed middle is
// removed from the audio too. Kept here rather than in the worker so the cut
// maths can be checked without a browser.
export function pcmSpans(ranges, sampleRate, totalFrames, chunkFrames) {
  const spans = [];
  for (const range of ranges) {
    const first = Math.min(totalFrames, Math.max(0, Math.round(range.start * sampleRate))),
      last = Math.min(totalFrames, Math.max(first, Math.round(range.end * sampleRate)));
    for (let at = first; at < last; at += chunkFrames)
      spans.push({
        offset: at,
        count: Math.min(chunkFrames, last - at),
        timestamp: range.outputStart + (at - first) / sampleRate,
      });
  }
  return spans;
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
  // Zoom the placed object around its centre, never change the source crop.
  const zoom = Math.min(4, Math.max(0.25, crop.zoom ?? 1));
  return {
    left,
    top,
    width: sw,
    height: sh,
    drawX: (crop.centerX == null ? availX * offsetX + drawWidth / 2 : crop.centerX * width) - drawWidth * zoom / 2,
    drawY: (crop.centerY == null ? availY * offsetY + drawHeight / 2 : crop.centerY * height) - drawHeight * zoom / 2,
    drawWidth: drawWidth * zoom,
    drawHeight: drawHeight * zoom,
  };
}
