// True while a blur box should be on screen. Missing timings mean the whole
// clip, which is what every box saved before blur had a timeline meant.
export function blurVisible(region, currentTimeMs) {
  return (
    currentTimeMs >= (region.startMs ?? 0) &&
    currentTimeMs <= (region.endMs ?? Number.POSITIVE_INFINITY)
  );
}
// Separable, edge-clamped box passes approximate a Gaussian without Canvas
// filter support. Runtime is linear in pixel count, not blur radius.
export function blurPixels(data, width, height, radius) {
  const r = Math.max(1, Math.round(radius));
  const temp = new Uint8ClampedArray(data.length);
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      const length = horizontal ? width : height;
      const lines = horizontal ? height : width;
      const index = (line, p, c) => ((horizontal ? line * width + p : p * width + line) * 4 + c);
      for (let line = 0; line < lines; line++) for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += data[index(line, Math.max(0, Math.min(length - 1, k)), c)];
        for (let p = 0; p < length; p++) {
          temp[index(line, p, c)] = sum / (2 * r + 1);
          sum += data[index(line, Math.min(length - 1, p + r + 1), c)] - data[index(line, Math.max(0, p - r), c)];
        }
      }
      data.set(temp);
    }
  }
  return data;
}
