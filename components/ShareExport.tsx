"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Share2, X } from "lucide-react";
import { fileUrl } from "@/lib/api";
import { rememberedExport } from "@/lib/exportBlobs";
import type { Export } from "@/lib/types";
import { videoFileName, shareVideoFile } from "@/shared/file-share.mjs";

export default function ShareExport({
  item,
  onClose,
}: {
  item: Export;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState("Preparing MP4 for sharing…");
  const [sharing, setSharing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    const element = dialog.current!;
    const controller = new AbortController();
    element.showModal();
    async function prepare() {
      try {
        if (
          !window.isSecureContext ||
          !navigator.share ||
          !navigator.canShare
        ) {
          setStatus(
            "File sharing is unavailable in this browser. Download the MP4 and attach it in Telegram.",
          );
          return;
        }
        if (item.size > 128 * 1024 * 1024) {
          setStatus(
            "This file is large for phone sharing. Download it and attach it in Telegram.",
          );
          return;
        }
        // This device may still be holding the file it rendered, in which
        // case there is nothing to prepare -- downloading it back from the
        // server is how "Preparing MP4" used to sit there for minutes on a
        // phone, re-fetching bytes it had just finished uploading.
        let blob = rememberedExport(item.id);
        if (!blob) {
          const response = await fetch(fileUrl("export", item.id, "file"), {
            credentials: "same-origin",
            signal: controller.signal,
          });
          if (!response.ok)
            throw new Error(
              "Unable to load this export. It may have expired; refresh and try again.",
            );
          blob = await response.blob();
        }
        if (controller.signal.aborted) return;
        if (!blob.size || !blob.type.toLowerCase().startsWith("video/mp4"))
          throw new Error(
            "The export did not return an MP4 video. Please download it again.",
          );
        const prepared = new File([blob], videoFileName(item.name), {
          type: "video/mp4",
        });
        if (!navigator.canShare({ files: [prepared] })) {
          setStatus(
            "This browser cannot share this MP4. Download it and attach it in Telegram.",
          );
          return;
        }
        setFile(prepared);
        setSupported(true);
        setStatus(
          "Ready. Tap Share MP4, then choose Telegram. The video file—not a link—will be shared.",
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setStatus(
            error instanceof Error
              ? error.message
              : "Could not prepare the video.",
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void prepare();
    return () => {
      controller.abort();
      element.close();
    };
  }, [item.id, item.name, item.size]);

  function share() {
    if (!file || sharing) return;
    // navigator.share() has to be the very first thing this tap does.
    // Android Chrome rejects it with NotAllowedError ("Permission denied")
    // if anything at all runs before it -- a setState and the re-render it
    // schedules was enough to lose the tap's transient activation. So the
    // call goes out synchronously and the UI catches up afterwards, rather
    // than the other way round.
    // Deliberately omits url/text: receiving apps should get only the MP4.
    let pending: Promise<void>;
    try {
      pending = shareVideoFile(navigator, file);
    } catch (error) {
      report(error);
      return;
    }
    setSharing(true);
    pending
      .then(() =>
        setStatus(
          "Video handed to the share menu. Complete sending in your chosen app.",
        ),
      )
      .catch(report)
      .finally(() => setSharing(false));
  }
  function report(error: unknown) {
    // Anything but a cancel names what actually went wrong. "Sharing could
    // not open" on its own gave no way to tell a browser that refuses the
    // file from one that lost the tap's user activation from one that ran
    // out of memory -- three different problems with three different fixes.
    const name = error instanceof Error ? error.name : "";
    const detail = error instanceof Error ? error.message : String(error);
    setStatus(
      name === "AbortError"
        ? "Sharing cancelled. You can try again."
        : name === "NotAllowedError"
          ? "Android blocked the share because the tap wasn't registered in time. Tap Share MP4 once more — or use Download MP4 and attach it."
          : `Sharing could not open — ${name || "error"}: ${detail.slice(0, 160)}. Try again, or download the MP4 and attach it in Telegram.`,
    );
  }

  return (
    <dialog
      ref={dialog}
      className="modal share-export-dialog"
      aria-labelledby="share-export-title"
      onClose={onClose}
    >
      <button
        className="close"
        aria-label="Close file sharing"
        onClick={onClose}
      >
        <X />
      </button>
      <h2 id="share-export-title">Share video file</h2>
      <p>{item.name}</p>
      <p role="status" aria-live="polite">
        {status}
      </p>
      <div className="share-export-actions">
        <button
          className="primary"
          disabled={loading || !supported || sharing}
          onClick={share}
        >
          {loading || sharing ? (
            <LoaderCircle size={18} />
          ) : (
            <Share2 size={18} />
          )}
          {loading ? "Preparing…" : sharing ? "Sharing…" : "Share MP4"}
        </button>
        <a className="subtle" href={fileUrl("export", item.id, "file", true)}>
          <Download size={18} /> Download MP4
        </a>
      </div>
    </dialog>
  );
}
