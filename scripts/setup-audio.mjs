import {
  mkdir,
  readdir,
  copyFile,
  writeFile,
  readFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  MODEL_PATH,
  MODEL_SHA256,
  ORT_DIR,
  ORT_VERSION,
  checkAudioAssets,
} from "../server/audio-assets.mjs";

// `--verify` checks an existing installation without downloading anything: run
// it on the server as part of a deployment, before anyone discovers the
// missing model by pressing Remove vocals.
const verifyOnly = process.argv.includes("--verify");
const report = (result) => {
  for (const problem of result.missing) console.error(`  - ${problem}`);
};

if (verifyOnly) {
  const result = checkAudioAssets(process.cwd(), { hash: true });
  if (!result.available) {
    console.error("Vocal removal is not installed correctly:");
    report(result);
    console.error("Run `pnpm setup:audio` on this machine.");
    process.exit(1);
  }
  console.log(`${result.detail} Checksum verified.`);
  process.exit(0);
}

await mkdir(ORT_DIR, { recursive: true });
await mkdir(path.dirname(MODEL_PATH), { recursive: true });
const runtime = "node_modules/onnxruntime-web";
const installed = JSON.parse(
  await readFile(path.join(runtime, "package.json"), "utf8"),
).version;
// The model is pinned to one runtime build; copying a different one over it
// would leave a workspace that looks installed and fails at inference time.
if (installed !== ORT_VERSION)
  throw new Error(
    `onnxruntime-web ${installed} is installed, but Kim Vocal 2 is pinned to ${ORT_VERSION}. Change the pin in server/audio-assets.mjs and public/audio/worker.js together, or reinstall the dependency.`,
  );
await copyFile("public/audio/ONNX-LICENSE.txt", path.join(ORT_DIR, "LICENSE"));
for (const name of await readdir(path.join(runtime, "dist")))
  if (/\.(wasm|mjs|js)$/.test(name))
    await copyFile(path.join(runtime, "dist", name), path.join(ORT_DIR, name));
const valid = (buffer) =>
  createHash("sha256").update(buffer).digest("hex") === MODEL_SHA256;
let cached;
try {
  cached = await readFile(MODEL_PATH);
} catch {}
if (!cached || !valid(cached)) {
  console.log("Downloading pinned Kim Vocal 2 model (66.8 MB)…");
  const response = await fetch(
    "https://huggingface.co/Blane187/all_public_uvr_models/resolve/main/Kim_Vocal_2.onnx",
  );
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!valid(bytes))
    throw new Error(
      "Model checksum changed. Review the artifact before upgrading.",
    );
  await writeFile(MODEL_PATH, bytes);
}
// Same check the server runs, so a successful setup and a healthy server
// cannot disagree about whether the feature is available.
const result = checkAudioAssets(process.cwd());
if (!result.available) {
  console.error("Installation finished but did not verify:");
  report(result);
  process.exit(1);
}
console.log(`${result.detail} Verify later with \`pnpm verify:audio\`.`);
