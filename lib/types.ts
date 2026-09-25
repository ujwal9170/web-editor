export type Media = {
  id: string;
  name: string;
  caption: string;
  source: string;
  sourceMediaId?: string;
  status: string;
  duration: number;
  width: number;
  height: number;
  size: number;
  expiresAt: number;
  createdAt: number;
};
export type Segment = { startMs: number; endMs: number; enabled: boolean };
export type Overlay = {
  id: string;
  text: string;
  font: string;
  // Separate from the font: every face can be drawn at its own weight or at
  // 700. Optional only for edits written before the switch existed.
  bold?: boolean;
  color: string;
  size: number;
  x: number;
  y: number;
  startMs: number;
  endMs: number;
};
export type Edit = {
  version: 1;
  canvas: {
    aspectRatio: "9:16";
    background: { type: string; colors: string[]; angle: number };
  };
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
    offsetX?: number;
    offsetY?: number;
    zoom?: number;
    centerX?: number;
    centerY?: number;
  };
  segments: Segment[];
  textOverlays: Overlay[];
  audio: { mode: string; derivativeId: string | null };
  // Fractions of the finished canvas, not of the source -- see editSchema.
  // A list: several things in one frame can need hiding, and each box has its
  // own span of the source timeline.
  blur: BlurRegion[];
};
export type BlurRegion = {
  // Absent on boxes saved before the list existed; the editor assigns one.
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  intensity: number;
  // Absent means the whole clip.
  startMs?: number;
  endMs?: number;
};
// Reusable style preset: crop/background/text, no timing or a specific clip.
export type Template = {
  id: string;
  name: string;
  edit: {
    canvas: Edit["canvas"];
    crop: Edit["crop"];
    textOverlays: Omit<Overlay, "startMs" | "endMs">[];
  };
  createdAt: number;
};
export type Project = {
  id: string;
  mediaId: string;
  name: string;
  caption: string;
  edit: Edit;
  revision: number;
  media?: Media;
  updatedAt: number;
};
export type Export = {
  id: string;
  projectId: string;
  name: string;
  caption: string;
  duration: number;
  createdAt: number;
  size: number;
  expiresAt: number;
};
export type Job = {
  id: string;
  type: string;
  status: string;
  progress: number;
  error?: string;
  resultId?: string;
  // Where this job sits in the server-wide line: 1 is next to start, 0 means
  // it is running already. The counts describe the whole server, not one
  // account, which is what makes a wait explainable.
  queuePosition?: number;
  queueRunning?: number;
  queueWaiting?: number;
  queueLimit?: number;
};
export type Limits = {
  retentionHours: number;
  storage: {
    level: "ok" | "warning" | "full";
    message: string;
    usedBytes: number;
    freeBytes: number | null;
    quotaBytes: number;
  };
};
export type AudioModel = {
  available: boolean;
  detail: string;
  missing: string[];
};
