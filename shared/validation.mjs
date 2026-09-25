import { z } from "zod";
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
// A text colour is checked against this list, not just against a hex pattern,
// so it has to carry every swatch the editor offers (lib/canvas.ts) -- a
// colour missing here is a swatch that saves fine on screen and is rejected
// by the server.
export const textColors = [
  "#FFFFFF",
  "#111827",
  "#FF4D6D",
  "#FACC15",
  "#FFD700",
  "#FFBF00",
  "#38BDF8",
];
// Matches fontFaces in lib/canvas.ts. Falls back rather than rejecting: the
// three fonts this list used to carry are gone, and an edit saved with one of
// them has to keep opening -- it just draws in Inter now.
export const fonts = [
  "Inter",
  "Inter Medium",
  "Open Sans",
  "Rubik",
  "Zilla Slab",
];
const unit = z.number().finite().min(0).max(1);
// Enough to cover a handle, a logo and a face at once without turning every
// frame of an export into a dozen separate blur passes. Kept in step with the
// copy in lib/canvas.ts, which is what the editor's Add button reads.
export const MAX_BLUR_REGIONS = 6;
const blurRegionSchema = z
  .object({
    // Assigned by the editor so a box keeps its identity across a save while
    // others are added or removed. Optional: boxes saved before the list
    // existed have none, and get one the next time the editor writes them.
    id: z.string().max(80).optional(),
    x: unit,
    y: unit,
    width: unit.gt(0),
    height: unit.gt(0),
    intensity: z.number().min(1).max(100),
    // Absent means "the whole clip", which is both what a box saved before
    // blur had a timeline meant and the right default for a new one.
    startMs: z.number().min(0).optional(),
    endMs: z.number().positive().optional(),
  })
  .refine(
    (b) => b.x + b.width <= 1.001 && b.y + b.height <= 1.001,
    "Blur region exceeds the frame",
  );
export const editSchema = z.object({
  version: z.literal(1),
  canvas: z.object({
    aspectRatio: z.literal("9:16"),
    background: z.object({
      type: z.enum(["solid", "gradient"]),
      colors: z.array(color).min(1).max(3),
      angle: z.number().min(0).max(360),
    }),
  }),
  crop: z
    .object({
      x: unit,
      y: unit,
      width: unit.gt(0),
      height: unit.gt(0),
      // Where the cropped rectangle draws on the canvas -- independent of
      // x/y/width/height (which only select source pixels). Left as
      // .optional() rather than defaulted: absent means "use whatever
      // position cropping alone implies" (see cropGeometry() in
      // shared/export.mjs), which a hardcoded default here would erase.
      offsetX: unit.optional(),
      offsetY: unit.optional(),
      zoom: z.number().finite().min(0.25).max(4).optional(),
      centerX: unit.optional(),
      centerY: unit.optional(),
    })
    .refine(
      (c) => c.x + c.width <= 1.001 && c.y + c.height <= 1.001,
      "Crop exceeds source bounds",
    ),
  segments: z
    .array(
      z
        .object({
          startMs: z.number().min(0),
          endMs: z.number().positive(),
          enabled: z.boolean(),
        })
        .refine((s) => s.endMs > s.startMs),
    )
    .min(1)
    .max(100),
  textOverlays: z
    .array(
      z.object({
        id: z.string().max(80),
        text: z.string().max(500),
        font: z.enum(fonts).catch("Inter"),
        // Its own switch rather than a weight baked into the font choice.
        // Defaulted to true so every overlay written before this existed keeps
        // the weight it was drawn at.
        bold: z.boolean().default(true),
        color: z.enum(textColors),
        size: z.number().min(16).max(120),
        x: unit,
        y: unit,
        startMs: z.number().min(0),
        endMs: z.number().positive(),
      }),
    )
    .max(12),
  audio: z.object({
    mode: z.enum(["original", "mute", "remove-vocals", "vocals-only"]),
    derivativeId: z.string().uuid().nullable(),
  }),
  // Rectangles of the finished 9:16 frame to blur. x/y/width/height are
  // fractions of the CANVAS, like textOverlays and unlike crop (which selects
  // source pixels), because what they hide is a thing the viewer sees in the
  // final frame, wherever the footage under it happens to sit. Timing is in
  // source coordinates, again like text, so a box stays over the thing it
  // hides as clips are removed and restored.
  blur: z
    .preprocess(
      // A single box used to be stored as one bare object, or null for none.
      // Both still arrive -- from projects saved before this, and from a tab
      // that has not reloaded since -- and become a one-box list.
      (value) => (value == null ? [] : Array.isArray(value) ? value : [value]),
      z.array(blurRegionSchema).max(MAX_BLUR_REGIONS),
    )
    .default([]),
});
export function validateEdit(raw, durationMs) {
  const spec = editSchema.parse(raw);
  let end = 0;
  for (const s of spec.segments) {
    if (s.startMs < end - 1 || s.endMs > durationMs + 100)
      throw new Error("Segments must be ordered and within the video.");
    end = s.endMs;
  }
  if (!spec.segments.some((s) => s.enabled))
    throw new Error("Keep at least one clip.");
  for (const t of spec.textOverlays)
    if (t.endMs <= t.startMs || t.endMs > durationMs + 100)
      throw new Error("Text timing must be within the source.");
  for (const b of spec.blur) {
    const start = b.startMs ?? 0,
      end = b.endMs ?? durationMs;
    if (end <= start || end > durationMs + 100)
      throw new Error("Blur timing must be within the source.");
  }
  return spec;
}
export function instagramUrl(raw) {
  const url = new URL(z.string().max(2048).parse(raw));
  if (
    url.protocol !== "https:" ||
    !["instagram.com", "www.instagram.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/(reel|p|tv)\/[A-Za-z0-9_-]{4,32}\/?$/.test(url.pathname)
  )
    throw new Error("Enter a public Instagram Reel or video-post link.");
  return `https://www.instagram.com${url.pathname.replace(/\/$/, "")}/`;
}
export function videoLink(raw) {
  const error =
    "Paste a public Instagram, YouTube or TikTok video link (not a profile or playlist).";
  let url;
  try {
    url = new URL(z.string().trim().max(2048).parse(raw));
  } catch {
    throw new Error(error);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error(error);
  const host = url.hostname;
  if (["instagram.com", "www.instagram.com"].includes(host))
    return {
      url: instagramUrl(url.href),
      source: "instagram",
      label: "Instagram",
    };
  if (
    ["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(
      host,
    )
  ) {
    const id =
      host === "youtu.be"
        ? /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1]
        : url.pathname === "/watch"
          ? url.searchParams.getAll("v").length === 1
            ? url.searchParams.get("v")
            : null
          : /^\/(?:shorts|embed|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1];
    if (id && /^[\w-]{11}$/.test(id))
      return {
        url: `https://www.youtube.com/watch?v=${id}`,
        source: "youtube",
        label: "YouTube",
      };
  }
  if (["tiktok.com", "www.tiktok.com", "m.tiktok.com"].includes(host)) {
    if (
      /^\/@[\w.-]+\/video\/\d{10,25}\/?$/.test(url.pathname) ||
      /^\/t\/[A-Za-z0-9]{4,80}\/?$/.test(url.pathname)
    )
      return {
        url: `https://www.tiktok.com${url.pathname.replace(/\/$/, "")}/`,
        source: "tiktok",
        label: "TikTok",
      };
  }
  if (
    ["vm.tiktok.com", "vt.tiktok.com"].includes(host) &&
    /^\/[A-Za-z0-9]{4,80}\/?$/.test(url.pathname)
  )
    return {
      url: `https://${host}${url.pathname.replace(/\/$/, "")}/`,
      source: "tiktok",
      label: "TikTok",
    };
  throw new Error(error);
}
// A template is the subset of an edit that generalizes across different
// source clips -- crop, background, text styling/position. Segments and
// audio mode are deliberately excluded: they only make sense relative to a
// specific video's own timeline/vocals. textOverlays carries no startMs/
// endMs for the same reason -- applying a template gives it a fresh
// full-duration span on whatever clip it's applied to.
export const templateEditSchema = z.object({
  canvas: editSchema.shape.canvas,
  crop: editSchema.shape.crop,
  textOverlays: z
    .array(
      editSchema.shape.textOverlays.element.omit({
        startMs: true,
        endMs: true,
      }),
    )
    .max(12),
});
export function validateTemplate(raw) {
  return templateEditSchema.parse(raw);
}
// Builds a full edit for a fresh project from a template plus the new
// clip's own duration -- text overlays span the whole clip by default.
export function editFromTemplate(templateEdit, durationMs) {
  return {
    version: 1,
    canvas: templateEdit.canvas,
    crop: templateEdit.crop,
    segments: [{ startMs: 0, endMs: durationMs, enabled: true }],
    textOverlays: templateEdit.textOverlays.map((t) => ({
      ...t,
      startMs: 0,
      endMs: durationMs,
    })),
    audio: { mode: "original", derivativeId: null },
    // Not part of a template: a blur hides something in one specific clip's
    // footage, so carrying it onto a different clip would cover whatever
    // happens to be at those coordinates there instead.
    blur: [],
  };
}
export function initialEdit(durationMs) {
  return {
    version: 1,
    canvas: {
      aspectRatio: "9:16",
      background: { type: "solid", colors: ["#000000", "#000000"], angle: 135 },
    },
    crop: { x: 0, y: 0, width: 1, height: 1 },
    segments: [{ startMs: 0, endMs: durationMs, enabled: true }],
    textOverlays: [],
    audio: { mode: "original", derivativeId: null },
    blur: [],
  };
}
