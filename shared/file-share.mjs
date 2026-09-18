export function videoFileName(name) {
  return (
    (name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\.mp4$/i, "")
      .trim()
      .slice(0, 100) || "edited-video") + ".mp4"
  );
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
