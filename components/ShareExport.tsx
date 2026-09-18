"use client";

import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, Share2, X } from "lucide-react";
import { fileUrl } from "@/lib/api";
import { rememberedExport } from "@/lib/exportBlobs";
import type { Export } from "@/lib/types";
import { videoFileName, shareVideoFile, canShareFiles } from "@/shared/file-share.mjs";

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
        if (!window.isSecureContext || !canShareFiles(navigator)) {
          // Said plainly rather than discovered by failing: desktop Chrome
          // and Edge cannot pass a file to an app, whatever canShare() claims,
          // so offering a share button here only produces a dead end.
          setStatus(
            "Desktop browsers can't send a file to another app — only phones can. Open this page on your phone to share straight into Telegram. Downloading here still works.",
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
        let blob = await rememberedExport(item.id);
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
    } catch {
      saveToDevice("This browser can't share files.");
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
  // Saves straight from the file already in hand -- no request, no waiting.
  function saveToDevice(because: string) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setStatus(`${because} The MP4 is saved to this device — attach it from your downloads.`);
  }
  function report(error: unknown) {
    const name = error instanceof Error ? error.name : "";
    const detail = error instanceof Error ? error.message : String(error);
    // A cancel is the one case where the person already got what they asked
    // for: they opened the sheet and backed out. Everything else means the
    // handover failed, and no amount of retrying fixes a browser that will
    // not pass files to the OS -- desktop Chrome and Edge report
    // canShare({files}) as true and then refuse the share itself. Rather
    // than explaining that and leaving them to press a second button, the
    // file just gets saved. Whatever goes wrong, they end up with the video.
    if (name === "AbortError") {
      setStatus("Sharing cancelled. Tap Share MP4 to try again.");
      return;
    }
    saveToDevice(
      name === "NotAllowedError"
        ? "This browser wouldn't hand the file to the share menu."
        : `Sharing failed (${name || "error"}: ${detail.slice(0, 90)}).`,
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
        {file ? (
          // Saves the copy already in memory rather than asking the server
          // for bytes this device is holding.
          <button className="subtle" onClick={() => saveToDevice("Saved.")}>
            <Download size={18} /> Download MP4
          </button>
        ) : (
          <a className="subtle" href={fileUrl("export", item.id, "file", true)}>
            <Download size={18} /> Download MP4
          </a>
        )}
      </div>
    </dialog>
  );
}
