import { cropGeometry } from "../shared/export.mjs";
import { blurPixels } from "../shared/blur.mjs";
import type { Edit, Overlay } from "./types";
// Every face the Text tab offers, with the weight it draws at when Bold is
// off. Bold is a separate switch, so "Inter Medium" is not a weight choice
// that Bold then contradicts -- it is the face's own weight, and Bold takes
// any of them to 700. Zilla Slab stands in for Rockwell Bold Condensed, which
// is Monotype's and cannot be shipped with a web page.
// Kept in step with the list in shared/validation.mjs, which is what decides
// whether a saved overlay is accepted.
export const fontFaces: Record<string, { family: string; weight: number }> = {
  Inter: { family: "Inter", weight: 400 },
  "Inter Medium": { family: "Inter", weight: 500 },
  "Open Sans": { family: "Open Sans", weight: 400 },
  Rubik: { family: "Rubik", weight: 400 },
  "Zilla Slab": { family: "Zilla Slab", weight: 400 },
};
export const fonts = Object.keys(fontFaces);
// The one place a font string is built, so the preview, the drag handle's
// measurement, the font preload and the export can never disagree about
// which face is being drawn.
export function fontStyle(
  t: { font: string; bold?: boolean },
  sizePx: number,
) {
  const face = fontFaces[t.font] ?? fontFaces.Inter;
  return `${(t.bold ?? true) ? 700 : face.weight} ${sizePx}px "${face.family}"`;
}
// Kept in step with the same list in shared/validation.mjs, which is what
// actually decides whether a saved overlay is accepted.
export const textColors = [
  "#FFFFFF",
  "#111827",
  "#FF4D6D",
  "#FACC15",
  "#FFD700",
  "#FFBF00",
  "#38BDF8",
];
export const bgColors = [
  "#111827",
  "#FFFFFF",
  "#7C3AED",
  "#FF4D6D",
  "#38BDF8",
  "#C8A77D",
];
export function dimensions(
  ratio: string,
  quality: "1080p" | "720p" = "1080p",
): [number, number] {
  return quality === "720p" ? [720, 1280] : [1080, 1920];
}
export type Crop = {
  x: number;
  y: number;
  width: number;
  height: number;
  // Where the cropped rectangle draws on the canvas -- see cropGeometry()
  // in shared/export.mjs. Absent means "wherever cropping alone implies."
  offsetX?: number;
  offsetY?: number;
  zoom?: number;
  centerX?: number;
  centerY?: number;
};
// Smallest fraction of the source either dimension may keep -- below this a
// drag handle or a symmetric slider could invert or zero out the crop.
export const MIN_CROP = 0.08;
export function clampCrop(crop: Crop): Crop {
  const width = Math.min(1, Math.max(MIN_CROP, crop.width)),
    height = Math.min(1, Math.max(MIN_CROP, crop.height));
  return {
    ...crop,
    width,
    height,
    x: Math.min(1 - width, Math.max(0, crop.x)),
    y: Math.min(1 - height, Math.max(0, crop.y)),
  };
}
export type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export function background(
  ctx: Context2D,
  edit: Edit,
  width: number,
  height: number,
) {
  const bg = edit.canvas.background;
  ctx.fillStyle = bg.colors[0];
  if (bg.type === "gradient") {
    const angle = (bg.angle * Math.PI) / 180,
      dx = Math.sin(angle),
      dy = -Math.cos(angle),
      reach = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
    const gradient = ctx.createLinearGradient(
      width / 2 - dx * reach,
      height / 2 - dy * reach,
      width / 2 + dx * reach,
      height / 2 + dy * reach,
    );
    bg.colors.forEach((color, i) =>
      gradient.addColorStop(i / Math.max(1, bg.colors.length - 1), color),
    );
    ctx.fillStyle = gradient;
  }
  ctx.fillRect(0, 0, width, height);
}
// fillText's own 4th (maxWidth) argument is supposed to auto-compress text
// that's too wide, but Safari/WebKit -- the engine an on-device export
// actually runs through when it's triggered from an iPhone -- doesn't honor
// it together with textAlign "center": instead of shrinking, it just
// overflows past both edges. Shrinking the font ourselves and calling plain
// fillText (no maxWidth) sidesteps that inconsistency entirely, since plain
// text measurement/sizing is consistent everywhere. Shared by text() and
// measureOverlay() so the drag handle's box never disagrees with the render.
// The bands the platforms draw their own chrome over. Text is kept out of
// them both by the drag clamp (Editor.tsx) and by the wrap below, so the two
// can never disagree about where the usable frame ends.
export const SAFE_ZONE = { top: 0.07, left: 0.07, right: 0.07 };
// A word with no break in it that is wider than the line gets broken anyway,
// at the last character that fits. Rare -- a pasted URL, a long hashtag -- but
// without it such a word is the one thing that could still force the whole
// block to shrink.
function splitLongWord(ctx: Context2D, word: string, maxWidth: number) {
  const parts: string[] = [];
  let chunk = "";
  for (const character of word) {
    const candidate = chunk + character;
    if (chunk && ctx.measureText(candidate).width > maxWidth) {
      parts.push(chunk);
      chunk = character;
    } else chunk = candidate;
  }
  if (chunk) parts.push(chunk);
  return parts;
}
// Breaks a paragraph at the last word that still fits, so a longer caption
// costs a line rather than shrinking every word already on screen.
function wrapParagraph(ctx: Context2D, text: string, maxWidth: number) {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      // A word that cannot fit a line of its own is dealt with before it is
      // joined to anything: checking only after joining missed the case where
      // such a word starts the line, which is how one could still run past
      // the edge.
      if (ctx.measureText(word).width > maxWidth) {
        if (line) out.push(line);
        const parts = splitLongWord(ctx, word, maxWidth);
        out.push(...parts.slice(0, -1));
        line = parts.at(-1) ?? "";
        continue;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(candidate).width > maxWidth) {
        out.push(line);
        line = word;
      } else line = candidate;
    }
    out.push(line);
  }
  return out;
}
function fitText(ctx: Context2D, t: Overlay, width: number) {
  const scale = width / 1080;
  const maxWidth = width * (1 - SAFE_ZONE.left - SAFE_ZONE.right);
  let fontSize = t.size * scale;
  ctx.font = fontStyle(t, fontSize);
  // Long text now runs onto another line at the safe edge instead of the
  // whole block shrinking to fit on one -- typing a longer caption should
  // cost a line, not the size of every word already there.
  // No shrink-to-fit pass any more: wrapping breaks even an unbreakable word,
  // so nothing can be too wide, and the size that was chosen is the size that
  // renders however much gets typed.
  return { lines: wrapParagraph(ctx, t.text, maxWidth), fontSize };
}
export function text(
  ctx: Context2D,
  t: Overlay,
  width: number,
  height: number,
) {
  const { lines, fontSize } = fitText(ctx, t, width);
  ctx.fillStyle = t.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  // t.x/t.y are the text BLOCK's own center, on both axes, not a corner --
  // so it stays sitting on whatever point it's anchored to (the video's own
  // center, by default) no matter how many lines get typed, rather than
  // only growing downward away from a fixed top.
  const top = t.y * height - (fontSize * 1.25 * lines.length) / 2;
  lines.forEach((line, i) =>
    ctx.fillText(line, t.x * width, top + i * fontSize * 1.25),
  );
}
// The drag hotspot for a text overlay needs its actual rendered footprint,
// not a guess -- reuses text()'s exact fit so it never drifts from what's
// really on screen.
export function measureOverlay(
  ctx: Context2D,
  t: Overlay,
  width: number,
  height: number,
) {
  const { lines, fontSize } = fitText(ctx, t, width);
  const w = Math.max(1, ...lines.map((line) => ctx.measureText(line).width));
  const h = fontSize * 1.25 * Math.max(1, lines.length);
  return { width: w, height: h };
}
// Shared by the live preview and the on-device WebCodecs export -- a decoded
// VideoSample's toCanvasImageSource() and an HTMLVideoElement both satisfy
// CanvasImageSource, so the exact same crop/scale/overlay math produces
// pixel-identical output whether the frame source is a <video> or a decoded
// export frame.
// Smallest blur box that's still grabbable by its handles on a phone.
export const MIN_BLUR = 0.01;
// Breadth goes much narrower than height: hiding a handle, a timestamp or a
// watermark strip wants a thin vertical band, and 0.015 of 1080 is still 16
// real pixels wide. It stays usable that narrow because the corner handles
// step outside the box once it's thinner than they are (.blur-frame.narrow in
// globals.css), instead of piling on top of each other.
export const MIN_BLUR_WIDTH = 0.015;
// Intensity is a 1-100 dial, not a pixel count: the same setting has to look
// the same at 720p and 1080p, so it resolves against the canvas width rather
// than being stored as pixels.
export function blurRadius(intensity: number, width: number) {
  return Math.max(1, (intensity / 100) * 0.07 * width);
}
let scratch: OffscreenCanvas | HTMLCanvasElement | null = null;
function scratchCanvas(w: number, h: number) {
  if (!scratch)
    scratch =
      typeof OffscreenCanvas === "function"
        ? new OffscreenCanvas(w, h)
        : document.createElement("canvas");
  scratch.width = w;
  scratch.height = h;
  return scratch;
}
// Blurs one rectangle of whatever is already on the canvas. Runs after the
// frame is drawn and before any text, so it hides footage without smearing
// the caption sitting over it.
export function blurRegion(
  ctx: Context2D,
  edit: Edit,
  width: number,
  height: number,
) {
  const b = edit.blur;
  if (!b) return;
  const radius = blurRadius(b.intensity, width);
  const x = Math.round(b.x * width),
    y = Math.round(b.y * height),
    w = Math.max(1, Math.round(b.width * width)),
    h = Math.max(1, Math.round(b.height * height));
  // The region is copied out with a margin and blurred with that margin
  // included, then clipped back to the exact rectangle. Blurring the bare
  // rectangle instead would sample transparent pixels from beyond its edges
  // and leave a pale halo just inside them.
  const pad = Math.ceil(radius * 2);
  const sx = Math.max(0, x - pad),
    sy = Math.max(0, y - pad),
    sw = Math.min(width - sx, w + (x - sx) + pad),
    sh = Math.min(height - sy, h + (y - sy) + pad);
  if (sw <= 0 || sh <= 0) return;
  // Bound processing cost on phones; the blurred image needs far fewer
  // pixels than the source. This also works when Canvas filter is absent.
  const reduction = Math.max(1, radius / 3);
  const bw = Math.max(1, Math.ceil(sw / reduction)), bh = Math.max(1, Math.ceil(sh / reduction));
  const buffer = scratchCanvas(bw, bh);
  const bctx = buffer.getContext("2d") as Context2D | null;
  if (!bctx) return;
  bctx.drawImage(ctx.canvas as CanvasImageSource, sx, sy, sw, sh, 0, 0, bw, bh);
  const pixels = bctx.getImageData(0, 0, bw, bh);
  blurPixels(pixels.data, bw, bh, radius / reduction);
  bctx.putImageData(pixels, 0, 0);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(buffer as CanvasImageSource, 0, 0, bw, bh, sx, sy, sw, sh);
  ctx.restore();
}
export function compose(
  ctx: Context2D,
  edit: Edit,
  width: number,
  height: number,
  frame: CanvasImageSource | null,
  sourceWidth: number,
  sourceHeight: number,
  currentTimeMs: number,
) {
  background(ctx, edit, width, height);
  if (frame && sourceWidth && sourceHeight) {
    const g = cropGeometry(edit.crop, sourceWidth, sourceHeight, width, height);
    ctx.drawImage(
      frame,
      g.left,
      g.top,
      g.width,
      g.height,
      g.drawX,
      g.drawY,
      g.drawWidth,
      g.drawHeight,
    );
  }
  blurRegion(ctx, edit, width, height);
  edit.textOverlays
    .filter((t) => currentTimeMs >= t.startMs && currentTimeMs <= t.endMs)
    .forEach((t) => text(ctx, t, width, height));
}
export function preview(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  edit: Edit,
) {
  const [width, height] = dimensions(edit.canvas.aspectRatio);
  if (ctx.canvas.width !== width) ctx.canvas.width = width;
  if (ctx.canvas.height !== height) ctx.canvas.height = height;
  compose(
    ctx,
    edit,
    width,
    height,
    video.readyState >= 2 ? video : null,
    video.videoWidth,
    video.videoHeight,
    video.currentTime * 1000,
  );
}
export type OverlayArtwork = { png: string | null; x: number; y: number };
const OVERLAY_PADDING = 2;
// Text is drawn on the full 1080x1920 canvas so preview and export stay pixel
// identical, then cropped to the pixels it actually covers. The worker
// composites that box at (x, y) instead of alpha-blending a whole transparent
// frame per overlay, which is where most of the render time used to go.
export function drawnBounds(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
) {
  const pixels = new Uint32Array(
    ctx.getImageData(0, 0, width, height).data.buffer,
  );
  let minX = width,
    minY = height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let first = -1,
      last = -1;
    // A cleared pixel is exactly 0x00000000, so any non-zero word was drawn.
    for (let x = 0; x < width; x++)
      if (pixels[row + x] !== 0) {
        if (first < 0) first = x;
        last = x;
      }
    if (first < 0) continue;
    if (y < minY) minY = y;
    maxY = y;
    if (first < minX) minX = first;
    if (last > maxX) maxX = last;
  }
  if (maxX < 0) return null;
  // Even offsets and sizes keep the 4:2:0 chroma plane aligned on export.
  const x = Math.max(0, minX - OVERLAY_PADDING) & ~1;
  const y = Math.max(0, minY - OVERLAY_PADDING) & ~1;
  let w = Math.min(width - x, maxX - x + 1 + OVERLAY_PADDING);
  let h = Math.min(height - y, maxY - y + 1 + OVERLAY_PADDING);
  if (w % 2) w = Math.min(width - x, w + 1);
  if (h % 2) h = Math.min(height - y, h + 1);
  return { x, y, width: w, height: h };
}
export async function artwork(
  edit: Edit,
  quality: "1080p" | "720p" = "1080p",
) {
  await document.fonts.ready;
  const [width, height] = dimensions(edit.canvas.aspectRatio, quality);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  background(ctx, edit, width, height);
  const bg = canvas.toDataURL("image/png");
  const crop = document.createElement("canvas");
  const cropCtx = crop.getContext("2d")!;
  const overlays: OverlayArtwork[] = edit.textOverlays.map((t) => {
    ctx.clearRect(0, 0, width, height);
    text(ctx, t, width, height);
    const box = drawnBounds(ctx, width, height);
    // Whitespace-only text draws nothing; the worker skips these entirely.
    if (!box) return { png: null, x: 0, y: 0 };
    crop.width = box.width;
    crop.height = box.height;
    cropCtx.drawImage(
      canvas,
      box.x,
      box.y,
      box.width,
      box.height,
      0,
      0,
      box.width,
      box.height,
    );
    return { png: crop.toDataURL("image/png"), x: box.x, y: box.y };
  });
  return { background: bg, overlays };
}
