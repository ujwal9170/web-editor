import { z } from "zod";
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const textColors = [
  "#FFFFFF",
  "#111827",
  "#FF4D6D",
  "#FACC15",
  "#38BDF8",
];
export const fonts = ["Inter", "DM Sans", "Montserrat", "Roboto"];
const unit = z.number().finite().min(0).max(1);
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
      // Position of the visible window within the cropped selection, once
      // that selection is scaled to cover the canvas -- see
      // shared/export.mjs's cropGeometry(). 0.5 is centered; defaulted so
      // edits saved before this field existed still parse.
      panX: unit.default(0.5),
      panY: unit.default(0.5),
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
        font: z.enum(fonts),
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
export function initialEdit(durationMs) {
  return {
    version: 1,
    canvas: {
      aspectRatio: "9:16",
      background: { type: "solid", colors: ["#111827", "#7C3AED"], angle: 135 },
    },
    crop: { x: 0, y: 0, width: 1, height: 1, panX: 0.5, panY: 0.5 },
    segments: [{ startMs: 0, endMs: durationMs, enabled: true }],
    textOverlays: [],
    audio: { mode: "original", derivativeId: null },
  };
}
