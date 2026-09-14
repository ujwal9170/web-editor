import { cropGeometry } from "../shared/export.mjs";
import type { Edit, Overlay } from "./types";
export const fonts = ["Inter", "DM Sans", "Montserrat", "Roboto"];
export const textColors = [
  "#FFFFFF",
  "#111827",
  "#FF4D6D",
  "#FACC15",
  "#38BDF8",
];
export const bgColors = ["#111827", "#FFFFFF", "#7C3AED", "#FF4D6D", "#38BDF8"];
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
  // Position of the visible window within the crop, once it's scaled to
  // cover the canvas -- see cropGeometry() in shared/export.mjs. Optional so
  // literals like { x: 0, y: 0, width: 1, height: 1 } stay valid; every
  // consumer falls back to 0.5 (centered) when absent.
  panX?: number;
  panY?: number;
};
// Smallest fraction of the source either dimension may keep -- below this a
// drag handle or a symmetric slider could invert or zero out the crop.
export const MIN_CROP = 0.08;
export function clampCrop(crop: Crop): Crop {
  const width = Math.min(1, Math.max(MIN_CROP, crop.width)),
    height = Math.min(1, Math.max(MIN_CROP, crop.height));
  return {
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
export function text(
  ctx: Context2D,
  t: Overlay,
  width: number,
  height: number,
) {
  const scale = width / 1080;
  ctx.font = `700 ${t.size * scale}px "${t.font}"`;
  ctx.fillStyle = t.color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const lines = t.text.split("\n");
  lines.forEach((line, i) =>
    ctx.fillText(
      line,
      t.x * width,
      t.y * height + i * t.size * scale * 1.25,
      width * 0.94,
    ),
  );
}
// The drag hotspot for a text overlay needs its actual rendered footprint,
// not a guess -- reuses text()'s exact font string so it never drifts from
// what's really on screen.
export function measureOverlay(
  ctx: Context2D,
  t: Overlay,
  width: number,
  height: number,
) {
  const scale = width / 1080;
  ctx.font = `700 ${t.size * scale}px "${t.font}"`;
  const lines = t.text.split("\n");
  const w = Math.max(1, ...lines.map((line) => ctx.measureText(line).width));
  const h = t.size * scale * 1.25 * Math.max(1, lines.length);
  return { width: w, height: h };
}
// Shared by the live preview and the on-device WebCodecs export -- a decoded
// VideoSample's toCanvasImageSource() and an HTMLVideoElement both satisfy
// CanvasImageSource, so the exact same crop/scale/overlay math produces
// pixel-identical output whether the frame source is a <video> or a decoded
// export frame.
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
