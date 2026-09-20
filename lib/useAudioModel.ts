"use client";
import { useEffect, useState } from "react";
import { api } from "./api";
import type { AudioModel } from "./types";

// Whether this server actually has the Kim Vocal 2 model and its matching
// ONNX Runtime installed. Asked once per page load and shared by every caller:
// the answer only changes when someone runs `pnpm setup:audio` on the server.
let pending: Promise<AudioModel> | null = null;
export function audioModelStatus(): Promise<AudioModel> {
  pending ??= api<AudioModel>("/audio-model").catch(() => ({
    // An unreachable check is not a missing model. Assume the feature works
    // and let the separation itself fail with its own message, rather than
    // greying out a button that would have worked.
    available: true,
    detail: "",
    missing: [],
  }));
  return pending;
}
export function useAudioModel(enabled: boolean) {
  const [model, setModel] = useState<AudioModel | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    audioModelStatus().then((value) => alive && setModel(value));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return model;
}
