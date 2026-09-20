import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

// Vocal removal is the one feature whose dependencies are not in Git: the
// pinned Kim Vocal 2 weights and the ONNX Runtime build that matches them are
// installed by `pnpm setup:audio`. Everything that needs to know whether they
// really are present on this machine -- the deployment check, the API, and
// through it the two buttons in the editor -- reads this one description of
// them, so a half-installed server says so instead of failing mid-separation.
export const ORT_VERSION = "1.21.0";
export const MODEL_PATH = "public/models/Kim_Vocal_2.onnx";
export const MODEL_SHA256 =
  "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";
export const MODEL_BYTES = 66_759_214;
export const ORT_DIR = "public/vendor/ort";
// The browser worker loads the WebGPU bundle and points ORT's loader at the
// same directory, so the jsep build (WebGPU) and the plain threaded build
// (CPU fallback) both have to be there.
export const ORT_FILES = [
  "ort.webgpu.min.js",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

function installedOrtVersion(projectRoot) {
  // Read from the dependency the assets were copied out of. A server that has
  // not run `pnpm install` (a trimmed production copy) simply cannot be
  // checked this way, and an unverifiable version is not a missing one.
  try {
    return JSON.parse(
      readFileSync(
        path.join(projectRoot, "node_modules/onnxruntime-web/package.json"),
        "utf8",
      ),
    ).version;
  } catch {
    return null;
  }
}

// `hash` re-reads all 67 MB and is meant for the deployment check; the API
// uses the cheap size check, which still catches a truncated or absent file.
export function checkAudioAssets(
  projectRoot = process.cwd(),
  { hash = false } = {},
) {
  const missing = [];
  const model = path.join(projectRoot, MODEL_PATH);
  const bytes = existsSync(model) ? statSync(model).size : 0;
  if (!bytes) missing.push(`the Kim Vocal 2 model (${MODEL_PATH}) is missing`);
  else if (bytes !== MODEL_BYTES)
    missing.push(
      `the Kim Vocal 2 model is ${bytes} bytes, expected ${MODEL_BYTES}`,
    );
  else if (
    hash &&
    createHash("sha256").update(readFileSync(model)).digest("hex") !==
      MODEL_SHA256
  )
    missing.push("the Kim Vocal 2 model failed its checksum");
  for (const name of ORT_FILES)
    if (!existsSync(path.join(projectRoot, ORT_DIR, name)))
      missing.push(`ONNX Runtime asset ${name} is missing`);
  const installed = installedOrtVersion(projectRoot);
  if (installed && installed !== ORT_VERSION)
    missing.push(
      `ONNX Runtime ${installed} is installed but the model is pinned to ${ORT_VERSION}`,
    );
  return {
    available: missing.length === 0,
    missing,
    detail: missing.length
      ? `Vocal removal is unavailable on this server: ${missing[0]}${
          missing.length > 1 ? ` (and ${missing.length - 1} more)` : ""
        }. Run \`pnpm setup:audio\` on the server.`
      : `Kim Vocal 2 and ONNX Runtime ${ORT_VERSION} are installed.`,
  };
}
