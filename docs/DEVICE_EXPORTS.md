# Device-only exports

The editor offers 720p (720×1280, 4 Mbps) and 1080p (1080×1920, 8 Mbps), H.264 MP4 at 30 fps. Audio is AAC 128 kbps / 48 kHz stereo, or absent for Mute. Original and already-applied processed stems are supported. Export does not run vocal separation.

`useDeviceExports` owns the queue at workspace level, not inside an Editor. Navigation between Media, Edits and Edited videos does not cancel work or redirect the employee on completion. The floating queue shows progress, success/errors, Cancel and View export. At most ten pending jobs and one active task per tab; Web Locks also serialize encoders across this app's tabs when supported. A different video can be edited during export, but device resources remain shared and preview performance can vary.

Each enqueue saves the edit then obtains an owner-scoped server snapshot ticket. Subsequent autosaves cannot change the running export's caption, title, crop, audio or timeline. Source/project deletion is blocked while a live ticket exists. Tickets expire after 24 hours; cancellation releases them. This is metadata/storage, not server rendering.

The dedicated worker decodes via range requests with a 16 MB cache, uses a two-canvas decode pool, prefers the hardware encoder after capability checks, rasterizes text once, and trims audio at clip boundaries. Encoded output has a 128 MB memory guard; larger exports require 720p or a shorter edit. Cancel terminates the worker and releases its resources. The queue continues to the next item on failure/cancellation.

Once upload/registration begins, Cancel is disabled to avoid suggesting that an already-committed server write can be undone. The API probes dimensions, duration and codecs, creates a thumbnail, and stores the original MP4 without re-encoding it. Downloads/import normalization and existing audio preparation still use server resources.

Server rendering is the other option, chosen per export in the same menu as the quality (`POST /api/projects/:id/renders`). The browser still draws the background and the text, because those have to match the preview exactly; FFmpeg does the video, the crop, the blur, the cuts and the audio. One render runs at a time and its FFmpeg is capped at a share of the machine, so a render cannot take the box down with it — see `MEDIA_CPU_SHARE` and `TYPE_LIMITS` in `server/jobs.mjs`. A render belongs to the server once queued: leaving the editor or closing the tab stops the progress line, not the work. A browser without WebCodecs gets the server preselected.

## Limitations and phone testing

- Requires a secure context (HTTPS, except localhost) and compatible browser codecs. No silent server fallback or silently dropped audio.
- Queue is in-memory, not recoverable after reload/tab closure. A before-unload warning and visible keep-awake notice are provided. Screen wake lock is best-effort. OS suspension, phone lock or switching browser apps is not guaranteed to continue processing; stalled workers time out with an error.
- Failed uploads currently require another export. Check Edited videos before retrying if a save response was lost.
- Actual iPhone performance must be measured over trusted HTTPS. Desktop synthetic tests are not phone benchmarks.
- Test both qualities with audio, mute, cuts, crop, text and blur; start another edit while rendering; cancel active/queued jobs; check cross-tab serialization, sign-out and unsupported-codec messages.
- For server export, check that a second render queues behind the first, that closing the tab still lands the export, and that the finished frame matches the on-device one for the same edit.

## Access fixes

Successful logins no longer consume a shared-proxy IP quota. Failed attempts are limited by normalized account name (8/minute), with in-flight accounting and a global concurrent password-hash cap. Forwarded IP headers are not blindly trusted. Deployment should add edge-level abuse protection.

Every session checks that its account still exists and its password hash matches the login version. CLI account removal/password reset therefore revokes existing sessions on their next request, as does admin-panel removal/reset.

Run `pnpm test`, `pnpm typecheck`, and `pnpm build`. The authenticated Node smoke test requires `SMOKE_USERNAME` and `SMOKE_PASSWORD` for a disposable account; it prepares a browser QA project, checks API behavior, and does not claim to exercise WebCodecs.
