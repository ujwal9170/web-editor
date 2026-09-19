export function exportQueueLabel(rows) {
  const pending = rows.filter(r => ["queued", "running", "saving"].includes(r.status)).length;
  if (pending) return `${pending} pending`;
  if (rows.some(r => r.status === "failed")) return "Failed";
  if (rows.some(r => r.status === "cancelled")) return "Cancelled";
  return "Finished";
}
