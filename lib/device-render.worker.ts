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
  Quality,
} from "mediabunny";
import {
  cropGeometry,
  exportProfile,
  exportTimeline,
  frameTimes,
  pcmSpans,
  AUDIO_DECODE_FAILED,
} from "../shared/export.mjs";
import { blurRegion } from "./canvas";
import type { RenderRequest, RenderArtwork, PcmAudio } from "./deviceExport";

// Dedicated worker: UI stays responsive and cancellation destroys decoders/encoders.
self.onmessage = async ({
  data,
}: MessageEvent<RenderRequest & { artwork: RenderArtwork }>) => {
  // The page answers a request for decoded audio on this same port (see
  // requestPcm below); those replies are not new jobs.
  if (!data?.artwork) return;
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
  // Asks the page to decode the whole audio track with decodeAudioData and
  // send the samples back. The page's media stack is not the same decoder as
  // WebCodecs: on iOS it reads codecs WebCodecs refuses outright.
  function requestPcm() {
    return new Promise<PcmAudio>((resolve, reject) => {
      const reply = ({ data: message }: MessageEvent) => {
        if (!message || (!message.pcm && !message.pcmError)) return;
        self.removeEventListener("message", reply);
        if (message.pcmError) reject(new Error(message.pcmError));
        else resolve(message.pcm);
      };
      self.addEventListener("message", reply);
      self.postMessage({ needPcm: true });
    });
  }
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
    const {
      width,
      height,
      bitrate,
      quantizer,
      fps: maxFps,
    } = exportProfile(data.resolution);
    const { ranges, duration } = exportTimeline(data.edit.segments);
    if (duration < 3) throw new Error("Keep at least 3 seconds for export.");
    // "quality" latency mode (best compression, since this isn't a live
    // call) is what a hardware encoder on a quirky/budget device is most
    // likely to reject -- canEncodeVideo only varied hardwareAcceleration
    // before, so a device whose encoder simply doesn't support "quality"
    // mode failed here at every resolution, with a message that (wrongly)
    // pointed at resolution as the fix. Try every combination before
    // actually giving up.
    const baseOptions = { width, height, bitrate };
    const modeCandidates = (
      ["prefer-hardware", "no-preference"] as const
    ).flatMap((hardwareAcceleration) =>
      (["quality", "realtime"] as const).map((latencyMode) => ({
        hardwareAcceleration,
        latencyMode,
      })),
    );
    let chosenMode: (typeof modeCandidates)[number] | undefined;
    for (const candidate of modeCandidates) {
      if (await canEncodeVideo("avc", { ...baseOptions, ...candidate })) {
        chosenMode = candidate;
        break;
      }
    }
    if (!chosenMode)
      throw new Error(
        "H.264 export is unavailable at this resolution. Try 720p, an updated Chrome, or a shorter edit.",
      );
    const { hardwareAcceleration, latencyMode } = chosenMode;
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
    // Being able to configure a decoder is not the same as being able to use
    // one. iOS Safari accepts an HE-AAC config -- what a low-bitrate reel
    // download often carries -- and then fails part way through the export
    // with "InternalAudioDecoderCocoa decoding failed", while the same file
    // exports fine on a laptop. Find that out here, on a fifth of a second of
    // audio, instead of minutes into a render: the page can decode the track
    // with decodeAudioData (a different decoder entirely, one that does read
    // HE-AAC) and send back PCM that goes straight to the encoder.
    let pcm: PcmAudio | null = data.pcm ?? null;
    if (audioTrack && !pcm) {
      const track = audioTrack;
      const usable = await (async () => {
        try {
          for await (const sample of new AudioSampleSink(track).samples(
            0,
            Math.min(0.2, duration),
          )) {
            sample.close();
            break;
          }
          return true;
        } catch {
          return false;
        }
      })();
      if (!usable) {
        progress("Reading this clip's audio…", 0, 0, true);
        pcm = await requestPcm();
      }
    }

    // Encoding a 24 or 25fps clip at 30 spends a fifth of every second on
    // frames that are copies of the one before -- bytes that buy nothing,
    // since the motion isn't there to begin with. Matching the source (never
    // exceeding the profile) is the one size saving that costs no quality at
    // all. A source already at or above the ceiling is unaffected.
    const stats = await videoTrack
      .computePacketStats(120)
      .catch(() => ({ averagePacketRate: 0 }));
    const sourceFps = Math.round(stats.averagePacketRate || 0);
    const fps = sourceFps > 0 ? Math.min(maxFps, sourceFps) : maxFps;
    const sourceWidth = await videoTrack.getDisplayWidth();
    const sourceHeight = await videoTrack.getDisplayHeight();
    const scale = Math.min(1, width / sourceWidth, height / sourceHeight);
    // Decode a complete, aspect-preserving frame first. Do not hand the crop
    // rectangle to the decoder: a native VideoFrame's own crop/resize path
    // disagrees with the source rectangle we computed on some mobile decoders
    // (Android especially), which stretched the entire export there while
    // desktop came out fine. Cropping the normalized canvas below is plain 2D
    // canvas maths, identical on every device.
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
      // Constant-quality rather than a flat bitrate: a still, simple shot
      // spends a fraction of the bits a busy one does, instead of every clip
      // being poured into the same 8 Mbps regardless of whether it needs it.
      // The file gets smaller because the easy parts stop being padded, not
      // because quality was lowered -- the quantizer is what's held constant.
      // bitrate stays on as a ceiling and, more importantly, as the fallback
      // mediabunny uses where quantizer encoding isn't available (it only
      // throws when no fallback is given). `quality` supersedes the
      // deprecated `bitrate` field.
      quality: new Quality({
        quantizer,
        bitrate,
        bitrateMode: "variable",
      }),
      hardwareAcceleration,
      latencyMode,
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
        // Same call the preview makes, in the same place in the draw order,
        // so what the blur hides on screen is what it hides in the file.
        blurRegion(ctx, data.edit, width, height);
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
    // Same cuts, same output timestamps, but read from one buffer the page
    // decoded rather than from a decoder running here.
    async function audioFromPcm(track: PcmAudio) {
      const channels = Math.max(1, track.numberOfChannels),
        rate = track.sampleRate,
        total = Math.floor(track.data.length / channels);
      for (const span of pcmSpans(
        ranges,
        rate,
        total,
        Math.max(1, Math.round(rate * 0.5)),
      )) {
        const sample = new AudioSample({
          data: track.data.subarray(
            span.offset * channels,
            (span.offset + span.count) * channels,
          ),
          format: "f32",
          numberOfChannels: channels,
          sampleRate: rate,
          timestamp: span.timestamp,
        });
        try {
          await audioSource!.add(sample);
        } finally {
          sample.close();
        }
      }
    }
    async function audio() {
      if (!audioTrack || !audioSource) return;
      if (pcm) {
        await audioFromPcm(pcm);
        audioSource.close();
        return;
      }
      try {
        await decodeAudio(new AudioSampleSink(audioTrack));
      } catch (e) {
        // A decoder that passed the probe and died later: tag it, so the page
        // knows this is the one failure worth retrying its own way instead of
        // showing the user a Cocoa error string and stopping.
        throw new Error(
          `${AUDIO_DECODE_FAILED}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      audioSource.close();
    }
    async function decodeAudio(audioSink: AudioSampleSink) {
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
            await audioSource!.add(clipped);
          } finally {
            clipped?.close();
            sample.close();
          }
        }
      }
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
