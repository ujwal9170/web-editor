import { background, text, drawnBounds, fontStyle } from "./canvas";
import { exportProfile, AUDIO_DECODE_FAILED } from "../shared/export.mjs";
import type { Edit } from "./types";

export type RenderProgress = {
  phase: string;
  progress: number;
  elapsed: number;
  fps?: number;
};
export type DeviceResult = {
  blob: Blob;
  seconds: number;
  frames: number;
  duration: number;
  encoder: string;
  resolution: number;
};
export type RenderRequest = {
  source: string;
  audioSource: string | null;
  edit: Edit;
  resolution: number;
  // Only set on a run that is working around this browser's audio decoder --
  // interleaved float samples for the whole track, decoded by the page.
  pcm?: PcmAudio | null;
};
export type PcmAudio = {
  data: Float32Array;
  sampleRate: number;
  numberOfChannels: number;
};
export type RenderArtwork = {
  background: ImageBitmap;
  overlays: {
    image: ImageBitmap;
    x: number;
    y: number;
    startMs: number;
    endMs: number;
  }[];
};
// A just-terminated worker's hardware encoder can take a moment to
// actually release its platform slot -- most mobile browsers allow only
// one or two concurrent video encoders at all. Matches the error text
// thrown by the browser's own encoder, not one Frame writes itself.
const ENCODER_BUSY = /ran out of (platform )?encoders?/i;

// The browser's *media* decoder, not its WebCodecs one. iOS Safari's WebCodecs
// audio decoder refuses codecs the same device plays without blinking --
// HE-AAC, which is what a low-bitrate download often carries -- so when it
// gives up, the page decodes the track here and hands the export raw samples.
// decodeAudioData resamples to the context's rate, which is the rate the
// export encodes at anyway.
async function decodeAudioTrack(request: RenderRequest): Promise<PcmAudio> {
  const processed = ["remove-vocals", "vocals-only"].includes(
    request.edit.audio.mode,
  );
  const url = processed ? request.audioSource : request.source;
  if (!url) throw new Error("This clip's audio is unavailable for export.");
  const Offline =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Offline)
    throw new Error(
      "This browser cannot decode the clip's audio. Try an updated browser.",
    );
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) throw new Error("Could not read this clip's audio.");
  const bytes = await response.arrayBuffer();
  const context = new Offline(2, 1, 48000);
  const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
    // Old WebKit only has the callback form; newer engines return a promise.
    const result = context.decodeAudioData(bytes, resolve, reject);
    if (result && typeof result.then === "function") result.then(resolve, reject);
  });
  const channels = Math.max(1, Math.min(2, buffer.numberOfChannels)),
    frames = buffer.length;
  if (frames * channels * 4 > 256 * 1024 * 1024)
    throw new Error(
      "This clip's audio is too long to decode on this device. Try a shorter edit.",
    );
  const data = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    const channel = buffer.getChannelData(c);
    for (let i = 0; i < frames; i++) data[i * channels + c] = channel[i];
  }
  return { data, sampleRate: buffer.sampleRate, numberOfChannels: channels };
}

export async function renderOnDevice(
  request: RenderRequest,
  signal: AbortSignal,
  onProgress: (progress: RenderProgress) => void,
): Promise<DeviceResult> {
  if (!window.isSecureContext)
    throw new Error(
      "Device export needs HTTPS. Plain HTTP over Wi-Fi will not work; use a trusted HTTPS test address.",
    );
  if (!("VideoEncoder" in window) || !("OffscreenCanvas" in window))
    throw new Error(
      "This browser cannot export on-device. Update Safari/iOS and try again.",
    );
  signal.throwIfAborted();
  // Load the exact font weights before rasterizing; fonts are never redrawn per frame.
  await Promise.all(
    request.edit.textOverlays.map((t) =>
      document.fonts.load(fontStyle(t, t.size), t.text || "A"),
    ),
  );
  await document.fonts.ready;
  signal.throwIfAborted();
  const { width, height } = exportProfile(request.resolution);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const images: ImageBitmap[] = [];
  let wake: WakeLockSentinel | undefined;
  try {
    background(ctx, request.edit, width, height);
    const bg = await createImageBitmap(canvas);
    images.push(bg);
    const overlays: RenderArtwork["overlays"] = [];
    for (const overlay of request.edit.textOverlays) {
      ctx.clearRect(0, 0, width, height);
      text(ctx, overlay, width, height);
      const box = drawnBounds(ctx, width, height);
      if (!box) continue;
      const image = await createImageBitmap(
        canvas,
        box.x,
        box.y,
        box.width,
        box.height,
      );
      images.push(image);
      overlays.push({
        image,
        x: box.x,
        y: box.y,
        startMs: overlay.startMs,
        endMs: overlay.endMs,
      });
    }
    signal.throwIfAborted();
    if (navigator.wakeLock)
      wake = await navigator.wakeLock.request("screen").catch(() => undefined);
    signal.throwIfAborted();

    // Decoded at most once per export, however many attempts ask for it.
    let decoded: Promise<PcmAudio> | undefined;
    function audioSamples() {
      decoded = decoded ?? decodeAudioTrack(request);
      return decoded;
    }
    // One attempt: its own worker, created and terminated fresh so a
    // retry never reuses a possibly-still-tearing-down encoder.
    async function attempt(pcm?: PcmAudio): Promise<DeviceResult> {
      let worker: Worker | undefined;
      try {
        worker = new Worker(
          new URL("./device-render.worker.ts", import.meta.url),
          { type: "module" },
        );
        const runningWorker = worker;
        return await new Promise<DeviceResult>((resolve, reject) => {
          let timeout: ReturnType<typeof setTimeout>;
          function clean() {
            clearTimeout(timeout);
            signal.removeEventListener("abort", cancelled);
          }
          function fail(error: Error) {
            clean();
            reject(error);
          }
          function cancelled() {
            fail(new DOMException("Export cancelled", "AbortError"));
          }
          function watchdog() {
            clearTimeout(timeout);
            timeout = setTimeout(
              () =>
                fail(
                  new Error(
                    "The device stopped responding. Try 720p or a shorter edit.",
                  ),
                ),
              90_000,
            );
          }
          signal.addEventListener("abort", cancelled, { once: true });
          runningWorker.onerror = (e) =>
            fail(
              new Error(
                e.message ||
                  "Device export failed. Try 720p or an updated browser.",
              ),
            );
          runningWorker.onmessage = ({ data }) => {
            if (data.error) {
              fail(new Error(data.error));
              return;
            }
            // The render is parked waiting for this, so hold the watchdog off
            // and say what the wait is for.
            if (data.needPcm) {
              watchdog();
              onProgress({
                phase: "Reading this clip's audio…",
                progress: 0,
                elapsed: 0,
              });
              audioSamples().then(
                (samples) => runningWorker.postMessage({ pcm: samples }),
                (e: unknown) =>
                  runningWorker.postMessage({
                    pcmError: e instanceof Error ? e.message : String(e),
                  }),
              );
              return;
            }
            if (data.phase) {
              watchdog();
              onProgress(data);
            }
            if (data.buffer) {
              clean();
              resolve({
                blob: new Blob([data.buffer], { type: "video/mp4" }),
                seconds: data.seconds,
                frames: data.frames,
                duration: data.duration,
                encoder: data.encoder,
                resolution: request.resolution,
              });
            }
          };
          watchdog();
          // Not transferred: a transfer would neuter these bitmaps in this
          // scope, and a retry attempt (see below) needs them intact to
          // send to its own fresh worker. The worker closes its own
          // (cloned) copies when it's done with them either way.
          runningWorker.postMessage({
            ...request,
            pcm: pcm ?? null,
            artwork: { background: bg, overlays },
          });
        });
      } finally {
        worker?.terminate();
      }
    }

    try {
      return await attempt();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // A decoder that only fails once it is past the opening samples: start
      // over with the page's own decoding rather than losing the export.
      if (message.includes(AUDIO_DECODE_FAILED)) {
        signal.throwIfAborted();
        onProgress({
          phase: "This device could not decode the clip's audio -- reading it another way…",
          progress: 0,
          elapsed: 0,
        });
        return await attempt(await audioSamples());
      }
      if (!ENCODER_BUSY.test(message)) throw e;
      signal.throwIfAborted();
      onProgress({
        phase: "This device's encoder is still busy from the last attempt -- retrying…",
        progress: 0,
        elapsed: 0,
      });
      await new Promise((r) => setTimeout(r, 1500));
      signal.throwIfAborted();
      try {
        return await attempt();
      } catch (e2) {
        const message2 = e2 instanceof Error ? e2.message : String(e2);
        throw new Error(
          ENCODER_BUSY.test(message2)
            ? "This device's video encoder is busy -- close other tabs or apps using video and try again."
            : message2,
        );
      }
    }
  } finally {
    images.forEach((image) => image.close());
    canvas.width = canvas.height = 1;
    await wake?.release().catch(() => {});
  }
}

export function deviceExportSupported() {
  return (
    window.isSecureContext &&
    typeof VideoEncoder !== "undefined" &&
    typeof VideoDecoder !== "undefined" &&
    typeof OffscreenCanvas !== "undefined" &&
    typeof Worker !== "undefined"
  );
}
