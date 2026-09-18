"use client";
import { useState } from "react";
import { ArrowUpRight, Scissors, Trash2 } from "lucide-react";
import { fileUrl, clock } from "@/lib/api";
import type { Media, Project } from "@/lib/types";

export default function ProjectCard({
  project,
  media,
  busy,
  onOpen,
  onDelete,
}: {
  project: Project;
  media?: Media;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  const available = media?.status === "ready";
  return (
    <article className="media-card">
      <button
        className="thumbnail"
        onClick={onOpen}
        disabled={busy || !available}
        aria-label={`Open edit ${project.name}`}
      >
        {available && !imageFailed ? (
          <img
            src={fileUrl("media", project.mediaId, "thumbnail")}
            alt={project.name}
            loading="lazy"
            decoding="async"
            onError={() => setImageFailed(true)}
          />
        ) : (
          <span className="placeholder">
            <Scissors size={28} />
            {available ? "Preview unavailable" : "Source unavailable"}
          </span>
        )}
        <span className="source-tag">Saved edit</span>
        {media?.duration && (
          <span className="duration">{clock(media.duration)}</span>
        )}
      </button>
      <div className="card-body">
        <h3>{project.name}</h3>
        <p>{new Date(project.updatedAt).toLocaleDateString()}</p>
        <div className="card-footer project-actions">
          <button
            className="subtle"
            onClick={onOpen}
            disabled={busy || !available}
          >
            Continue editing <ArrowUpRight size={16} />
          </button>
          <button
            title="Delete edit"
            aria-label={`Delete edit ${project.name}`}
            onClick={onDelete}
            disabled={busy}
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>
    </article>
  );
}
