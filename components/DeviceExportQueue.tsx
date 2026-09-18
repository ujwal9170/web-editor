"use client";
import { useEffect, useRef, useState } from "react";
import type { ExportRow } from "@/lib/useDeviceExports";
export default function DeviceExportQueue({
  rows,
  cancel,
  dismiss,
  openExports,
}: {
  rows: ExportRow[];
  cancel: (id: string) => void;
  dismiss: (id: string) => void;
  openExports: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // A successful export's toast clears itself -- there's nothing left to do
  // with it. A failed one needs the user to actually read why and decide
  // whether to retry, so that stays until dismissed by hand. Scheduled once
  // per row id (not re-armed on every re-render) so activity elsewhere in
  // the queue can't keep pushing a finished row's dismissal back.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    for (const row of rows) {
      if (row.status === "done" && !timers.current.has(row.id)) {
        timers.current.set(
          row.id,
          setTimeout(() => {
            dismiss(row.id);
            timers.current.delete(row.id);
          }, 2000),
        );
      }
    }
    for (const id of timers.current.keys())
      if (!rows.some((r) => r.id === id)) timers.current.delete(id);
  }, [rows, dismiss]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  if (!rows.length) return null;
  const pending = rows.filter((r) =>
    ["queued", "running", "saving"].includes(r.status),
  ).length;
  return (
    <aside className="device-export-queue" aria-label="Device export queue">
      <button
        className="subtle"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        Device exports · {pending ? `${pending} pending` : "Finished"}{" "}
        {expanded ? "▾" : "▴"}
      </button>
      {!expanded && <p className="hint">{rows.find(r => ["running", "saving"].includes(r.status))?.detail || rows.at(-1)?.detail} · Tap to manage</p>}
      <span className="sr-only" role="status">
        {rows.at(-1)?.status === "done"
          ? "Export complete. Open Edited videos."
          : rows.at(-1)?.status === "failed"
            ? `Export failed: ${rows.at(-1)?.detail}`
            : ""}
      </span>
      {expanded && (
        <>
          <p className="hint">
            You can edit another video. Keep this tab open and phone awake. One
            render at a time.
          </p>
          <div className="device-export-rows">
            {rows.map((row) => (
              <div className="device-export-row" key={row.id}>
                <strong>
                  {row.name} · {row.quality}
                </strong>
                <p>{row.detail}</p>
                {["queued", "running"].includes(row.status) && (
                  <button className="subtle" onClick={() => cancel(row.id)}>
                    Cancel
                  </button>
                )}
                {row.status === "saving" && (
                  <small>Saving cannot be cancelled.</small>
                )}
                {row.status === "done" && (
                  <button className="subtle" onClick={openExports}>
                    View export
                  </button>
                )}
                {["done", "failed", "cancelled"].includes(row.status) && (
                  <button className="subtle" onClick={() => dismiss(row.id)}>
                    Dismiss
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </aside>
  );
}
