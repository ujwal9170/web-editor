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
  };
  segments: Segment[];
  textOverlays: Overlay[];
  audio: { mode: string; derivativeId: string | null };
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
};
