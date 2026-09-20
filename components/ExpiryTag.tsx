"use client";
import { expiry } from "@/lib/api";

// The one place the retention countdown is drawn. It reads in hours because
// the window is short, and it turns urgent before the last few hours so a clip
// is never deleted out from under someone without warning. Opening a project
// no longer pushes the deadline back, which is why this has to be visible on
// the card rather than only in the settings.
export default function ExpiryTag({
  at,
  fallback = "",
}: {
  at?: number;
  fallback?: string;
}) {
  const left = expiry(at);
  if (!left) return fallback ? <span>{fallback}</span> : null;
  return (
    <span
      className={left.urgent ? "expiry urgent" : "expiry"}
      title="Deleted when this runs out. Opening or editing does not extend it."
    >
      {left.text}
    </span>
  );
}
