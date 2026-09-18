# Mobile export and file sharing

The mobile export change normalizes a complete decoded frame with aspect ratio
preserved, then crops the resulting canvas. Previously a cropped native
VideoFrame was resized directly into the crop destination. This avoids that
browser-sensitive path; the reported iPhone distortion still needs verification
with the user's original and exported MP4, not screenshots alone.

720p and 1080p remain 9:16 device-only exports. Existing exports must be regenerated.
Latest crop positioning, source-timed text, audio trims and serial queue remain.

## Phone acceptance test (HTTPS)

1. Import a portrait clip containing faces, circles or squares. Add text and
   crop top/bottom. Export at 720p and 1080p. Compare editor, saved MP4 and original:
   faces/circles must keep proportions, baked-in text must not flatten, and only
   cropped pixels should disappear. Repeat with landscape and rotation-tagged clips.
2. Test split/deleted audio, background colour and multiple queued exports.
3. In Edited videos, tap the share icon, wait for MP4 preparation, then tap
   **Share MP4** and choose Telegram. Verify the attachment is a playable video,
   not a website URL. No automatic recipient or send action is performed.
4. Cancel the share sheet and retry; close while preparing; try an expired export.
   Browser without file sharing should show the manual download/attach fallback.
5. Check a narrow phone screen for footer overflow and accessible touch targets.

Sharing requires browser/OS file-sharing support and a secure context. The MP4
is fetched with the existing authenticated endpoint. No Telegram bot, account
credentials or public video URL is used. A second explicit tap after preparation
preserves user activation; the share payload contains only `files`, never `url`.

Desktop automated tests are not a substitute for actual iPhone/Telegram testing.
