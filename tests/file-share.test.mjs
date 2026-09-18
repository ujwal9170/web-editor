import { test } from "node:test";
import assert from "node:assert/strict";
import { videoFileName, shareVideoFile } from "../shared/file-share.mjs";

test("sharing synchronously hands an MP4 file to the OS, never a page URL", async () => {
  const file = new File(["test bytes"], "reel.mp4", { type: "video/mp4" });
  let called = false;
  const pending = shareVideoFile(
    {
      canShare: (data) => data.files[0] === file,
      share: (data) => {
        called = true;
        assert.deepEqual(Object.keys(data), ["files"]);
        assert.equal(data.files[0], file);
        return Promise.resolve();
      },
    },
    file,
  );
  assert.equal(
    called,
    true,
    "must not await anything before invoking native sharing",
  );
  await pending;
});
test("unsupported file sharing never falls back to a URL share", () => {
  assert.throws(
    () =>
      shareVideoFile({ canShare: () => false, share: () => assert.fail() }, {}),
    /Download/,
  );
  assert.throws(() => shareVideoFile({}, {}), /Download/);
});
test("share cancellation propagates without retrying or sending", async () => {
  await assert.rejects(
    shareVideoFile(
      {
        canShare: () => true,
        share: () =>
          Promise.reject(new DOMException("Cancelled", "AbortError")),
      },
      {},
    ),
    { name: "AbortError" },
  );
});
test("video filenames are safe, bounded and have one mp4 suffix", () => {
  assert.equal(videoFileName("reel.MP4"), "reel.mp4");
  assert.equal(videoFileName("a/b:c"), "a_b_c.mp4");
  assert.equal(videoFileName("   "), "edited-video.mp4");
  assert.equal(videoFileName("x".repeat(200)).length, 104);
});
