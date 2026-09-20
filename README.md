# Frame / Editing Site

A modular Instagram, YouTube and TikTok video workspace: import a clip and caption, keep it in Media, edit it, and save a Reel-format MP4 plus its post caption in Edited Videos.

**Status: runnable development version.** Per-user private workspaces are implemented. Production cloud services and AI caption generation are still deferred. Exports are device-only; see [device exports and testing](docs/DEVICE_EXPORTS.md).

## Run locally

Requires Node.js **24+**, pnpm **10**, and Python **3.11+**. No separate FFmpeg installation is needed: `imageio-ffmpeg` supplies the executable.

```sh
pnpm install --frozen-lockfile
python -m venv .venv
```

On Windows:

```powershell
.venv\Scripts\python.exe -m pip install -r worker/requirements.txt
pnpm setup:audio
pnpm dev
```

On macOS/Linux:

```sh
.venv/bin/python -m pip install -r worker/requirements.txt
pnpm setup:audio
pnpm dev
```

Open **http://127.0.0.1:4174**. The launcher automatically uses the project virtual environment. The Fastify API runs on loopback port 4175 and is proxied through Next.js.

`setup:audio` downloads the requested Kim Vocal 2 model, checks its SHA-256, and copies the matching ONNX Runtime 1.21.0 assets; it refuses to install a runtime version other than the pinned one. Model weights and runtime binaries are ignored by Git and are reproduced by this command. `pnpm verify:audio` re-checks an existing installation (including the model checksum) without downloading anything, and exits non-zero when something is missing. All four fonts are bundled locally through Fontsource.

Optional settings are documented in `.env.example`. Copy it to `.env` when overriding defaults; leave `PYTHON` unset to use automatic virtual-environment detection. Never commit `.env`.

## Working features

- Public Instagram Reel/video-post, YouTube video/Shorts and TikTok video import via `yt-dlp`, including caption/description when available. Paste a direct link, `youtu.be` link, or TikTok `vm`/`vt`/`/t/` share link. The platform is detected automatically and shown in Media. A YouTube link with a playlist parameter imports only the selected video; profile links, whole playlists, and active/upcoming live streams are not supported.
- Imports retain the 15-minute/300 MB limits. Private, login-gated, age/region-restricted videos and platform rate limits can prevent downloads; no access-control bypass is used. TikTok must be reachable from the backend's network. The installed `yt-dlp[default]` package includes YouTube's EJS support, and the worker uses this app's Node executable for JavaScript processing.
- Device uploads up to 300 MB and 15 minutes, local thumbnails, searchable Media library, caption editing, downloads, and a strict 36-hour retention window.
- Fixed retention: a source is deleted 36 hours after it was imported and an export 36 hours after it was saved, along with their thumbnails and processed audio. Opening or editing never extends the deadline. Every Media and Export card shows the hours left and turns red in the last six.
- Server media jobs (download, normalize, instrument removal, export acceptance) run two at a time by default (`MEDIA_JOB_CONCURRENCY`); the rest wait in one line and each person is shown how many are processing and where their work sits in it.
- Storage safeguards: the workspace warns as free space runs low and refuses new imports and uploads (HTTP 507) before the disk fills, while everything else — editing, exporting, downloading — keeps working. The retention sweep frees space and lifts the pause on its own.
- Vocal separation is verified on the server: with the model or its runtime missing, the editor's Remove vocals / Keep vocals only buttons and the Instrument Remover queue are disabled with a message naming what to install.
- Saved projects with serialized autosave, revision-conflict detection, editable captions, and undo/redo for video edits.
- Editor library cards show source thumbnails and allow deleting a saved edit without deleting its source or exported videos. Deleting Media with linked edits requires explicit confirmation of the current edit count; it removes those drafts and processed stems, while exports stay available. Active render/audio jobs block deletion until they finish.
- Generated leading `Video by` text is removed from imported names and existing Media, project and export names; captions and custom non-prefixed titles are preserved.
- Fixed 9:16 Reel canvas (1080×1920), fill-frame crop, adjustable crop and fit-full-video.
- Text overlays with four bundled fonts, five text colors, positions, sizes and source-timeline timing.
- Five background swatches, custom HTML color input, and two/three-color gradients.
- Timeline split, disable/delete and restore; export skips disabled segments. Timings remain in source coordinates.
- Original audio, mute, Kim Vocal 2 vocal isolation and instrumental residual (`original - estimated vocals`), preview and apply.
- Browser audio processing: WebGPU preferred, WASM fallback (up to four threads with cross-origin isolation), exact 7680-point FFT, 44.1 kHz stereo, fixed model tensor, two-pass denoise and overlap-add. All DSP runs in a dedicated Worker; browser decoding precedes the Worker.
- Device-only MP4 export: 720p/1080p, H.264/AAC, 30 fps, crop/background/text/cuts, original/mute/applied processed audio. A dedicated browser worker and app-wide queue let employees edit another video during export, with progress and cancellation. No server-render option or fallback; the server only validates and stores the finished video and generates a thumbnail.
- Export library with playback, full caption preview, a top Copy caption button with success feedback, video/caption downloads and deletion. Empty captions disable copying; blocked clipboard access selects the text for manual copying. Source/project stay intact when deleting an export.

Source imports are converted to a high-quality H.264 editing copy (CRF 18). This is not a bit-for-bit copy of the platform's original file. Export is another encode. Instagram upload acceptance has not been tested against a real account.

## Structure and future changes

```text
app/                 Next.js application, shared theme and workspace screen
components/          Editor and its tool panels
lib/                 Frontend API, canvas drawing, audio orchestration, types
shared/              Server-validated edit contract and supported video URL rules
server/app.mjs       Fastify routes and workspace access checks
server/repository.mjs SQLite persistence adapter
server/jobs.mjs      Concurrency-limited media-job runner and worker protocol
server/storage.mjs   Disk headroom measurement behind the import safeguard
server/audio-assets.mjs Installed vocal-removal model/runtime check
worker/              Python downloader, normalization and FFmpeg rendering
public/audio/        Browser audio Worker and mixed-radix DSP
scripts/             Dev launcher, model setup and end-to-end smoke check
tests/               Validation, persistence, auth and DSP regressions
docs/                Target product plan and extension guide
```

Edit state is versioned JSON; source files are immutable after import. Background and text artwork use the preview's canvas functions and are rasterized once into cropped bitmaps for the device worker. Device export follows the stable-window crop geometry and original source-timeline text timings. Vocal separation covers the full source so processed audio stays aligned as clips are removed/restored. Applied stems are stored by this application, then read by device export; no AI service is involved.

`runtime/` holds SQLite, media, project derivatives and exports. Keep it on persistent storage and back it up. Retention is fixed at creation and cannot be extended from the app: sources, exports, their thumbnails and processed stems are removed `SOURCE_RETENTION_HOURS` (default 36) after import or export, and abandoned partial uploads are swept after six hours. A source still being read by a running job is kept until that job ends. Expired sources make associated projects unavailable until reimport; the edits themselves are kept. Raising `SOURCE_RETENTION_HOURS` extends existing records, and lowering it applies to them as well — the window is recomputed from each record's creation time on startup.

Current development adapters use SQLite, one shared server media-job queue with a small concurrency limit, local files and per-user ownership. PostgreSQL, Redis/BullMQ, S3/R2 signed storage and resilient distributed jobs remain part of the [target plan](docs/PRODUCT_PLAN.md).

## Verification

```sh
pnpm test
pnpm typecheck
pnpm build
# While pnpm dev is running: creates clearly labelled disposable QA media
node scripts/smoke.mjs
```

The authenticated smoke check prepares a synthetic six-second clip and a four-second cut/text edit, verifies range playback, stale-write rejection, both export snapshot qualities and rejection of server renders. Set SMOKE_USERNAME and SMOKE_PASSWORD for an existing disposable account. Browser verification is separate: test 720p/1080p output, navigation during export and Cancel. Tests also cover FFT/STFT reconstruction; synthetic tests do not establish musical separation quality or iPhone performance.

Multi-platform validation covers supported URL forms, permission checks, platform tagging, queue routing, extractor selection, live/duration limits and the stdout protocol. A public YouTube sample completed a real download and normalization during local verification. The TikTok sample reached its extractor but the host connection timed out; successful TikTok downloading still needs verification on a network that can reach TikTok.

## Deployment and access

For a persistent Node/Python host, run `pnpm build`, install Python dependencies and the audio model, then `pnpm start`. Set `HOST=0.0.0.0` and the exact HTTPS `PUBLIC_ORIGIN` behind a reverse proxy. The launcher refuses a non-loopback bind until at least one account exists.

Run `pnpm setup:audio` and then `pnpm verify:audio` as part of every deployment: vocal removal needs the pinned Kim Vocal 2 weights and ONNX Runtime 1.21.0 on the server, and neither is in Git. The API repeats the check at startup (logging `[audio] …` when something is missing) and serves it at `/api/audio-model`, which is what disables the editor's vocal buttons with a clear message instead of failing mid-separation.

Size the host for the retention window rather than the library: with `SOURCE_RETENTION_HOURS=36` the disk holds roughly a day and a half of imports and exports. `STORAGE_RESERVE_GB` (default 2) is the free space that must remain before imports are paused, and `STORAGE_LIMIT_GB` optionally caps what `DATA_DIR` itself may occupy; both are reported to the browser through `/api/limits`.

Each person signs in with their own account and sees only their own media, edits and exports. Accounts are created from the command line, so the server exposes no signup route:

```sh
pnpm user add <username>     # prompts for a password
pnpm user list
pnpm user passwd <username>
pnpm user remove <username>
```

Ownership is enforced server-side on every record and on the file routes, so knowing another person's media id is not enough to read, download or delete it.

Serve the app with COOP/COEP headers (configured in `next.config.mjs`) to enable WASM threads. The reverse proxy must allow 300 MB uploads and video range requests. Runtime files, `.env`, and SQLite must never be served as public static files. The API streams only record-referenced media files and checks the workspace session. This full pipeline needs a persistent Node/Python host; a static-only deployment cannot execute FFmpeg jobs.

## Development branches

`develop` is the integration branch; `main` receives tested checkpoints. Existing feature branches remain available for downloader, Media, editor, caption assistant, exports and infrastructure. Start future work from the latest `develop`, and merge changes without resetting unrelated branch work.

The caption feature stays on the roadmap and `feature/ai-caption-assistant`; no OpenAI API key is currently needed. See [extension guidance](docs/DEVELOPMENT.md) before adding a tool.
