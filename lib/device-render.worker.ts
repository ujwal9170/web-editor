import {
  Input,
  UrlSource,
  ALL_FORMATS,
  CanvasSink,
  CanvasSource,
  AudioSampleSink,
  AudioSample,
  AudioSampleSource,
  Output,
  BufferTarget,
  Mp4OutputFormat,
  canEncodeVideo,
  canEncodeAudio,
} from "mediabunny";
import {
  cropGeometry,
  exportProfile,
  exportTimeline,
  frameTimes,
} from "../shared/export.mjs";
import type { RenderRequest, RenderArtwork } from "./deviceExport";

// Dedicated worker: UI stays responsive and cancellation destroys decoders/encoders.
self.onmessage = async ({
  data,
}: MessageEvent<RenderRequest & { artwork: RenderArtwork }>) => {
  const started = performance.now();
  const inputs: Input[] = [];
  let output: Output | undefined;
  let lastProgress = 0;
  const progress = (phase: string, value = 0, frames = 0, force = false) => {
    const now = performance.now();
    if (!force && now - lastProgress < 250) return;
    lastProgress = now;
    self.postMessage({
      phase,
      progress: value,
      elapsed: (now - started) / 1000,
      fps: frames ? frames / ((now - started) / 1000) : undefined,
    });
  };
  function input(url: string) {
    const file = new Input({
      formats: ALL_FORMATS,
      source: new UrlSource(url, {
        maxCacheSize: 16 * 1024 * 1024,
        parallelism: 1,
        requestInit: { credentials: "same-origin" },
        getRetryDelay: (attempt) => (attempt < 2 ? 1 + attempt : null),
      }),
    });
    inputs.push(file);
    return file;
  }
  try {
    progress("Checking device support…", 0, 0, true);
    const { width, height, bitrate, fps } = exportProfile(data.resolution);
    const { ranges, duration } = exportTimeline(data.edit.segments);
    if (duration < 3) throw new Error("Keep at least 3 seconds for export.");
    const options = { width, height, bitrate, latencyMode: "quality" as const };
    let hardwareAcceleration: "prefer-hardware" | "no-preference" =
      "prefer-hardware";
    if (!(await canEncodeVideo("avc", { ...options, hardwareAcceleration }))) {
      hardwareAcceleration = "no-preference";
      if (!(await canEncodeVideo("avc", { ...options, hardwareAcceleration })))
        throw new Error(
          "H.264 export is unavailable at this resolution. Try 720p or a shorter edit.",
        );
    }
    const source = input(data.source);
    const videoTrack = await source.getPrimaryVideoTrack();
    if (!videoTrack || !(await videoTrack.canDecode()))
      throw new Error(
        "This browser cannot decode the source video. Try an updated browser or a supported source.",
      );
    const processed = ["remove-vocals", "vocals-only"].includes(
      data.edit.audio.mode,
    );
    if (processed && !data.audioSource)
      throw new Error("Apply the processed audio before exporting.");
    const audioInput = processed ? input(data.audioSource!) : source;
    const audioTrack =
      data.edit.audio.mode === "mute"
        ? null
        : await audioInput.getPrimaryAudioTrack();
    if (processed && !audioTrack)
      throw new Error("Processed audio is unavailable.");
    if (audioTrack && !(await audioTrack.canDecode()))
      throw new Error(
        "This browser cannot decode the audio. Try an updated browser or a supported source.",
      );
    if (
      audioTrack &&
      !(await canEncodeAudio("aac", {
        sampleRate: 48000,
        numberOfChannels: 2,
        bitrate: 128_000,
      }))
    )
      throw new Error(
        "AAC audio export is unavailable in this browser. Try an updated Safari/iOS or another supported browser; audio will not be silently removed.",
      );

    const sourceWidth = await videoTrack.getDisplayWidth();
    const sourceHeight = await videoTrack.getDisplayHeight();
    const scale = Math.min(1, width / sourceWidth, height / sourceHeight);
    // Decode a complete, aspect-preserving frame first. Do not crop/resize a
    // native VideoFrame into the cropped box: mobile decoder/canvas paths can
    // disagree about its source rectangle. Crop the normalized canvas below.
    const sink = new CanvasSink(videoTrack, {
      width: Math.max(2, Math.round(sourceWidth * scale)),
      fit: "contain",
      poolSize: 2,
    });
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d", { alpha: false })!;
    const target = new BufferTarget();
    output = new Output({
      target,
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
    });
    let encodedBytes = 0;
    const countBytes = (packet: { data: Uint8Array }) => {
      encodedBytes += packet.data.byteLength;
      if (encodedBytes > 128 * 1024 * 1024)
        throw new Error(
          "Export exceeds the device memory budget. Try 720p or a shorter edit.",
        );
    };
    const videoSource = new CanvasSource(canvas, {
      codec: "avc",
      bitrate,
      hardwareAcceleration,
      latencyMode: "quality",
      keyFrameInterval: 2,
      onEncodedPacket: countBytes,
    });
    const audioSource = audioTrack
      ? new AudioSampleSource({
          codec: "aac",
          bitrate: 128_000,
          transform: { sampleRate: 48000, numberOfChannels: 2 },
          onEncodedPacket: countBytes,
        })
      : null;
    output.addVideoTrack(videoSource, { frameRate: fps });
    if (audioSource) output.addAudioTrack(audioSource);
    await output.start();
    let frames = 0;
    const frameCount = Math.ceil(duration * fps - 1e-7);
    async function video() {
      const times = frameTimes(ranges, duration, fps);
      const sourceTimes = (function* () {
        for (const t of frameTimes(ranges, duration, fps)) yield t.sourceTime;
      })();
      for await (const frame of sink.canvasesAtTimestamps(sourceTimes)) {
        const time = times.next().value!;
        if (!frame)
          throw new Error(
            "A source frame could not be decoded. Try an updated browser or a supported source.",
          );
        ctx.drawImage(data.artwork.background, 0, 0);
        const geometry = cropGeometry(
          data.edit.crop,
          frame.canvas.width,
          frame.canvas.height,
          width,
          height,
        );
        ctx.drawImage(
          frame.canvas,
          geometry.left,
          geometry.top,
          geometry.width,
          geometry.height,
          geometry.drawX,
          geometry.drawY,
          geometry.drawWidth,
          geometry.drawHeight,
        );
        for (const overlay of data.artwork.overlays) {
          if (
            time.sourceTime * 1000 >= overlay.startMs &&
            time.sourceTime * 1000 <= overlay.endMs
          )
            ctx.drawImage(overlay.image, overlay.x, overlay.y);
        }
        await videoSource.add(time.outputTime, time.duration);
        frames++;
        progress(
          "Rendering on this device…",
          (frames / frameCount) * 0.95,
          frames,
        );
      }
      videoSource.close();
    }
    async function audio() {
      if (!audioTrack || !audioSource) return;
      const audioSink = new AudioSampleSink(audioTrack);
      for (const range of ranges) {
        for await (const sample of audioSink.samples(range.start, range.end)) {
          let clipped: AudioSample | undefined;
          try {
            const first = Math.max(
              0,
              Math.round((range.start - sample.timestamp) * sample.sampleRate),
            );
            const last = Math.min(
              sample.numberOfFrames,
              Math.round((range.end - sample.timestamp) * sample.sampleRate),
            );
            if (last <= first) continue;
            clipped = sample.trim(first, last);
            clipped.setTimestamp(
              Math.max(
                range.outputStart,
                range.outputStart + clipped.timestamp - range.start,
              ),
            );
            await audioSource.add(clipped);
          } finally {
            clipped?.close();
            sample.close();
          }
        }
      }
      audioSource.close();
    }
    progress("Rendering on this device…", 0, 0, true);
    await Promise.all([video(), audio()]);
    progress("Finalizing MP4…", 0.97, frames, true);
    await output.finalize();
    const buffer = target.buffer!;
    self.postMessage(
      {
        buffer,
        frames,
        duration,
        seconds: (performance.now() - started) / 1000,
        encoder:
          hardwareAcceleration === "prefer-hardware"
            ? "Hardware preferred (browser-selected)"
            : "Browser-selected encoder",
      },
      { transfer: [buffer] },
    );
  } catch (e) {
    await output?.cancel().catch(() => {});
    self.postMessage({
      error: e instanceof Error ? e.message : "Device export failed.",
    });
  } finally {
    inputs.forEach((file) => file.dispose());
    data.artwork.background.close();
    data.artwork.overlays.forEach((o) => o.image.close());
  }
};
