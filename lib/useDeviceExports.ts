"use client";
import { useEffect, useRef, useState } from "react";
import { api, fileUrl } from "./api";
import { createExportQueue } from "./exportQueue.mjs";
import { rememberExport } from "./exportBlobs";
import type { Project } from "./types";

// Some devices can't run an H.264 encoder at 1080p at all (weaker/older
// hardware, mostly) -- device-render.worker.ts throws this exact message
// when even the software fallback fails. 720p is far more broadly supported,
// so it's worth one automatic retry there before giving up entirely.
const RESOLUTION_UNSUPPORTED = /H\.264 export is unavailable at this resolution/i;

export type ExportTask = { project: Project; quality: "720p" | "1080p" };
export type ExportRow = {
  id: string;
  name: string;
  quality: string;
  status: string;
  detail: string;
  result?: string;
};
export function useDeviceExports() {
  const [queue] = useState(() =>
    createExportQueue(
      async (
        task: ExportTask,
        control: {
          signal: AbortSignal;
          progress: (s: string) => void;
          saving: () => void;
        },
      ) => {
        const { project, quality } = task;
        let ticketId: string | undefined;
        try {
          // The editor obtained the snapshot before enqueue; no current revision is
          // read here. Editing another clip cannot change what this task exports.
          ticketId = (task as ExportTask & { ticketId: string }).ticketId;
          const requestedResolution = quality === "720p" ? 720 : 1080;
          const run = async () => {
            control.signal.throwIfAborted();
            const { renderOnDevice } = await import("./deviceExport");
            const attemptAt = (resolution: number) =>
              renderOnDevice(
                {
                  source: new URL(
                    fileUrl("media", project.mediaId),
                    location.href,
                  ).href,
                  audioSource:
                    ["remove-vocals", "vocals-only"].includes(
                      project.edit.audio.mode,
                    ) && project.edit.audio.derivativeId
                      ? new URL(
                          fileUrl("audio", project.edit.audio.derivativeId),
                          location.href,
                        ).href
                      : null,
                  edit: project.edit,
                  resolution,
                },
                control.signal,
                (p) =>
                  control.progress(
                    `${p.phase} ${Math.round(p.progress * 100)}%`,
                  ),
              );
            try {
              return await attemptAt(requestedResolution);
            } catch (e) {
              const message = e instanceof Error ? e.message : String(e);
              if (
                requestedResolution !== 720 &&
                RESOLUTION_UNSUPPORTED.test(message)
              ) {
                control.progress(
                  "1080p isn't supported on this device -- exporting at 720p instead…",
                );
                return await attemptAt(720);
              }
              throw e;
            }
          };
          control.progress("Waiting for this device's export slot…");
          // Where supported, also avoid concurrent encoders in another app tab.
          const result = navigator.locks
            ? await navigator.locks.request(
                "frame-device-export",
                { signal: control.signal },
                run,
              )
            : await run();
          control.signal.throwIfAborted();
          control.saving(); // After this point Cancel is disabled: server registration is committing.
          const body = new FormData();
          body.append("file", result.blob, "export.mp4");
          const { job } = await api(
            `/projects/${project.id}/renders/device?ticketId=${ticketId}`,
            { method: "POST", body, signal: control.signal },
          );
          const deadline = Date.now() + 35 * 60_000;
          for (;;) {
            control.signal.throwIfAborted();
            const state = await api(`/jobs/${job.id}`, {
              signal: control.signal,
            });
            if (state.status === "ready") {
              // Hold on to what was just rendered so sharing it doesn't have
              // to fetch the same bytes back down again.
              rememberExport(state.resultId, result.blob);
              return state.resultId;
            }
            if (state.status === "failed") throw new Error(state.error);
            if (Date.now() > deadline)
              throw new Error(
                "Saving is taking too long. Check Edited videos before retrying.",
              );
            await new Promise((resolve) => setTimeout(resolve, 1200));
          }
        } finally {
          if (ticketId)
            await api(`/device-exports/${ticketId}`, {
              method: "DELETE",
            }).catch(() => {});
        }
      },
    ),
  );
  const [rows, setRows] = useState<ExportRow[]>([]);
  const tickets = useRef(new Map<string, string>());
  const generation = useRef(0);
  useEffect(() => {
    const unsubscribe = queue.subscribe(() => setRows(queue.list()));
    return () => {
      unsubscribe();
      queue.clear();
    };
  }, [queue]);
  const pending = rows.some((r) =>
    ["queued", "running", "saving"].includes(r.status),
  );
  useEffect(() => {
    if (!pending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [pending]);
  async function enqueue(task: ExportTask) {
    const session = generation.current;
    const snapshot = structuredClone(task);
    const { ticketId } = await api(
      `/projects/${snapshot.project.id}/renders/device/prepare`,
      {
        method: "POST",
        body: JSON.stringify({
          revision: snapshot.project.revision,
          quality: snapshot.quality,
        }),
      },
    );
    try {
      if (session !== generation.current)
        throw new Error("Signed out before export was queued.");
      const id = queue.add({ ...snapshot, ticketId });
      tickets.current.set(id, ticketId);
    } catch (error) {
      await api(`/device-exports/${ticketId}`, { method: "DELETE" }).catch(
        () => {},
      );
      throw error;
    }
  }
  function cancel(id: string) {
    if (queue.cancel(id)) {
      const ticket = tickets.current.get(id);
      if (ticket)
        void api(`/device-exports/${ticket}`, { method: "DELETE" }).catch(
          () => {},
        );
      tickets.current.delete(id);
    }
  }
  function clear() {
    generation.current++;
    queue.clear();
    for (const ticket of tickets.current.values())
      void api(`/device-exports/${ticket}`, { method: "DELETE" }).catch(
        () => {},
      );
    tickets.current.clear();
  }
  return {
    rows,
    pending,
    enqueue,
    cancel,
    clear,
    dismiss: (id: string) => {
      queue.dismiss(id);
      tickets.current.delete(id);
    },
  };
}
