"use client";
import {
  Film,
  Scissors,
  Captions,
  Download,
  Trash2,
  MoreVertical,
  ListPlus,
} from "lucide-react";
import { fileUrl, clock, size } from "@/lib/api";
import type { Media } from "@/lib/types";

const sourceLabels: Record<string, string> = {
  instagram: "Instagram",
  youtube: "YouTube",
  tiktok: "TikTok",
  "vocal-isolated": "Instruments removed",
};

export default function MediaCard({
  media: m,
  busy,
  onOpen,
  onCaption,
  onDelete,
  queueMenu,
}: {
  media: Media;
  busy: boolean;
  onOpen: () => void;
  onCaption: () => void;
  onDelete: () => void;
  queueMenu?: {
    open: boolean;
    queued: boolean;
    onToggle: () => void;
    onAdd: () => void;
  };
}) {
  return (
    <article className="media-card">
      <button
        className="thumbnail"
        onClick={() => m.status === "ready" && onOpen()}
        disabled={m.status !== "ready"}
      >
        {m.status === "ready" ? (
          <img
            src={fileUrl("media", m.id, "thumbnail")}
            alt={m.name}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="placeholder">
            <Film />
            <span>{m.status}</span>
          </div>
        )}
        <span className="source-tag">{sourceLabels[m.source] || "Uploaded"}</span>
        {m.duration ? <span className="duration">{clock(m.duration)}</span> : null}
        <span className="edit-hover">
          <Scissors size={18} /> Open in editor
        </span>
      </button>
      <div className="card-body">
        <h3>{m.name}</h3>
        <div className="meta">
          {m.width ? `${m.width} × ${m.height}` : "Preparing media"}{" "}
          <span>·</span> {size(m.size)}
        </div>
        <div className="card-footer">
          <span>
            {m.expiresAt
              ? `${Math.max(0, Math.ceil((m.expiresAt - Date.now()) / 86400_000))} days left`
              : m.status}
          </span>
          <div>
            <button
              aria-label={`Caption for ${m.name}`}
              onClick={onCaption}
            >
              <Captions size={17} />
            </button>
            {m.status === "ready" && (
              <a
                aria-label={`Download ${m.name}`}
                href={fileUrl("media", m.id, "file", true)}
              >
                <Download size={17} />
              </a>
            )}
            {queueMenu && (
              <div className="card-menu">
                <button
                  aria-label={`More actions for ${m.name}`}
                  aria-haspopup="menu"
                  aria-expanded={queueMenu.open}
                  onClick={queueMenu.onToggle}
                >
                  <MoreVertical size={16} />
                </button>
                {queueMenu.open && (
                  <div className="card-menu-list" role="menu">
                    <button
                      role="menuitem"
                      disabled={queueMenu.queued || m.status !== "ready"}
                      onClick={queueMenu.onAdd}
                    >
                      <ListPlus size={15} />
                      {queueMenu.queued
                        ? "Already queued"
                        : "Add to instrument removal queue"}
                    </button>
                  </div>
                )}
              </div>
            )}
            <button
              aria-label={`Delete ${m.name}`}
              disabled={busy || m.status === "processing"}
              onClick={onDelete}
            >
              <Trash2 size={16} />
            </button>
          </div>
        </div>
      </div>
    </article>
  );
}
