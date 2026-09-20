# Extension guide

## Add an editor tool

1. Extend `Edit` in `lib/types.ts` and its runtime validation in `shared/validation.mjs` together. Preserve existing saved projects or introduce an explicit version migration.
2. Add the controls to the relevant editor panel. Changes go through the editor's `change()` action so undo/redo and autosave continue to work.
3. Update `lib/canvas.ts` for preview and `worker/media.py` for export. Prefer shared canvas artwork for effects that must visually match. Artwork is drawn on the full canvas, then `artwork()` crops each overlay to its drawn bounds and sends `{ png, x, y }`; the worker composites at that offset. Keep offsets and box sizes even so the 4:2:0 chroma plane stays aligned, and keep the render route's `ARTWORK_*` ceilings in step with anything that makes artwork larger.
4. Add a regression with an observable output (duration, dimensions, color, timing, reconstruction), not merely a duplicate of the implementation.

## Replace infrastructure independently

- Implement the repository's `get/list/put/remove` contract with PostgreSQL. Add transactional revisions and ownership enforcement before offering private user accounts.
- Replace `createQueue` with Redis/BullMQ while keeping the JSON worker request/result protocol. Current interrupted jobs are marked failed after restart; they are not silently resumed.
- Introduce a storage adapter for upload/stream/delete and worker staging. Use S3/R2 signed URLs once the private storage service is configured.
- Keep credentials server-side. The caption assistant is explicitly deferred and should later expose separate configurable text and vision models.

## Known development limits

- One media worker process per job, two jobs at a time (`MEDIA_JOB_CONCURRENCY`), in a single in-memory queue that is lost on restart: waiting and running jobs are failed with "Server restarted" rather than resumed. Password sessions are in memory and also end at restart.
- Browser inference is device-dependent and does not use the hosting machine's GPU. A WebGPU provider preference does not prove every model operator ran on GPU.
- Audio separation does two inference passes; test on real vocal/music mixtures and multiple devices before calling its quality production-ready.
- The pinned model parameters came from the user's existing tested prototype. Windowing, compensation and edge handling should be compared against that implementation with identical audio fixtures.
- Canvas rasterized text matches the selected bundled fonts; caption text is separate from burned-in text.
- Overlay artwork is uploaded as base64 inside one JSON body, which the API buffers in memory. The render route allows a larger body than the rest of the API so image backgrounds and image overlays fit later; move this route to multipart before raising those ceilings much further.
- Undo/redo currently applies to edit-spec changes, not name/caption typing.
- The canvas is fixed to 9:16 (1080×1920). Fill Reel frame crops centrally; Fit full video restores the whole source inside that canvas.
- The sweep removes expired sources, their thumbnails and stems, expired exports, stale export tickets and abandoned partial uploads, on startup and every minute after. It measures the data directory by walking it, which is fine for one box and would need replacing alongside object storage. A source held open by a running job waits for the next pass. Per-account quotas do not exist: the safeguard is workspace-wide, so one person's imports can pause everyone's.
- Explicit source/project deletion now removes linked project and audio records atomically, then cleans their files; exports are independent. If Windows holds a file open, record deletion succeeds and the failed file cleanup is logged. Retrying orphan-file cleanup remains a hosting follow-up.
- Imported sources are normalized for editing rather than retained as a separate original-quality archive.
- No live Instagram posting integration, scheduled publishing, AI caption calls, or cloud deployment has been implemented.

## Release checks

Run tests, typecheck, build, and the local smoke workflow. Verify browser preview, crop/text/background, split/restore, save/reopen, and a short audio separation. Check the exported MP4's duration and codecs. Do not commit test media, runtime state, model weights or credentials.

For worker changes, also run `python -m unittest worker.test_media` using the Python environment with `worker/requirements.txt` installed. Worker stdout must contain only the final JSON result; library logs and progress belong on stderr. In particular, yt-dlp's `quiet` option alone does not suppress its progress bar. An Instagram empty-media response is an upstream retrieval failure, separate from this worker protocol.
