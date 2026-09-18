export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...options.headers,
    },
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    // A non-JSON body (an HTML error page from a proxy/tunnel, most often)
    // means something between the browser and the API hiccupped, not that
    // the request itself was rejected -- surface that distinction instead
    // of the raw "Unexpected token '<'" parse error.
    throw new Error(
      `The server didn't respond properly (HTTP ${response.status}). It may be restarting -- try again in a moment.`,
    );
  }
  if (!response.ok) throw new Error(data.error || "Request failed");
  return data;
}
// Remembers the last template a user applied so a freshly-opened editor can
// default to it -- read/written directly against localStorage since it's a
// per-device convenience, not something that needs to sync or persist server-side.
export const LAST_TEMPLATE_KEY = "frame:lastTemplateId";
export const fileUrl = (
  kind: string,
  id: string,
  type = "file",
  download = false,
) => `/api/files/${kind}/${id}/${type}${download ? "?download=1" : ""}`;
// "how long ago", in the coarsest unit that still says something useful: a
// fresh export reads "just now" rather than "0 minutes ago", and anything
// past a week is a date, since "23 days ago" is harder to place than the day
// it happened.
export function ago(at = 0) {
  const seconds = Math.max(0, (Date.now() - at) / 1000);
  if (seconds < 45) return "just now";
  const minutes = seconds / 60;
  if (minutes < 60)
    return `${Math.round(minutes)} min${Math.round(minutes) === 1 ? "" : "s"} ago`;
  const hours = minutes / 60;
  if (hours < 24)
    return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}
export const clock = (seconds = 0) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
export const size = (bytes = 0) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
export async function awaitJob(
  id: string,
  onProgress: (job: any) => void = () => {},
) {
  let failures = 0;
  for (;;) {
    let job;
    try {
      job = await api(`/jobs/${id}`);
      failures = 0;
    } catch (e) {
      // A job can run for minutes; don't give up on the first hiccup (a
      // brief server restart, a dropped tunnel connection) when the next
      // poll a moment later would likely have gone through fine.
      if (++failures >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1200));
      continue;
    }
    onProgress(job);
    if (job.status === "ready") return job;
    if (job.status === "failed") throw new Error(job.error);
    await new Promise((r) => setTimeout(r, 1200));
  }
}
