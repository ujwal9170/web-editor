export function videoFileName(name) {
  return (
    (name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\.mp4$/i, "")
      .trim()
      .slice(0, 100) || "edited-video") + ".mp4"
  );
}

// Whether this browser can actually hand a file to the OS share sheet.
// canShare({files}) is not a usable answer on its own: desktop Chrome and
// Edge return true for it and then reject share() with NotAllowedError, so
// the check has to include whether this is a platform that implements Web
// Share for files at all -- Android and iOS do, desktop browsers do not.
export function canShareFiles(browser) {
  if (!browser?.share || !browser?.canShare) return false;
  const mobile = browser.userAgentData?.mobile;
  if (mobile === false) return false;
  if (mobile === true) return true;
  return /Android|iPhone|iPad|iPod/i.test(browser.userAgent || "");
}

// Call synchronously from the user's click handler, after file preparation.
export function shareVideoFile(browser, file) {
  const payload = { files: [file] };
  if (!browser.canShare?.(payload) || !browser.share)
    throw new Error(
      "File sharing is unavailable. Download and attach the MP4 instead.",
    );
  return browser.share(payload);
}
