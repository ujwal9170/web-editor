# Server export review — 2026-09-28

Reviewed upstream `b9b3fe8` locally; no production deployment or server edits.

## Findings (fixed locally; deployment separate)

1. **Fixed locally: server renders ignored current video placement and zoom.**
   `worker/media.py:render` only reads legacy `offsetX`/`offsetY`, unlike
   `shared/export.mjs:cropGeometry`, which uses `centerX`, `centerY`, and `zoom`.
   Moving/pinching a video can therefore produce a server export different from
   the preview/device export. The current geometry is now ported, with 30
   cross-language parity cases and real 720p/1080p zoom/placement render tests.
   FFmpeg raster/chroma rounding is allowed at most two pixels in bounds tests.

2. **Fixed locally: thin, strong blur regions failed the entire server export.**
   `blur_filters` clamps luma radius but leaves the chroma radius at its default
   (the same value). On 4:2:0 frames the chroma plane is smaller. Reproduced with
   an actual 720p render, region x=.1/y=.2/width=.3/height=.03/intensity=100:
   `Invalid chroma_param radius value 18, must be >= 0 and <= 9`.
   Chroma radius now clamps to actual chroma-plane dimensions, including zero
   for two-pixel edge boxes. Actual 720p/1080p renders cover thin horizontal,
   vertical and edge-clipped regions at maximum intensity.

3. **Fixed locally: invalid audio selection leaked prepared artwork files.**
   The render route writes PNGs, exits its cleanup try/catch, then resolves the
   audio derivative. A missing, wrong-project or non-ready derivative throws
   before queue registration and neither cleanup callback ran. Audio validation
   now happens before any artwork is written. API tests cover missing, foreign,
   wrong-project and unfinished derivatives without new files or queued jobs;
   valid audio still queues. Partial writes are registered for cleanup before
   writing begins. Old orphan files are not retroactively deleted.

One-render-at-a-time scheduling and access tests pass, but passing unit tests
does not establish real VPS throughput or preview/export parity. FFmpeg thread
counts are not a hard CPU percentage limit.

## Colour metadata fix verified separately

The supplied 90-second H.264 sample has reserved value 3 in all three VUI colour
fields. Normalize now remuxes only malformed H.264 inputs with reserved fields
changed to unspecified (2), preserves valid fields and range, then follows the
existing normalization path (including HE-AAC to AAC-LC conversion). No colour
space is guessed and no extra video re-encode is introduced by the repair.
Temporary repair files are removed on success/failure; the source is not modified
by normalization. Actual sample normalization and thumbnail generation pass.

This is targeted H.264 reserved-tag handling, not a general HDR/tone-mapping or
arbitrary corrupt-file repair. Previously stored files are not migrated.
