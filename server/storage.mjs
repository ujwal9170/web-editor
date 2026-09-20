import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";

const GB = 1024 ** 3;

// Imports are stopped before the disk actually fills. A half-written 300 MB
// upload, an FFmpeg job that dies out of space and a SQLite file that cannot
// be flushed are all worse than a clear "no room right now" -- and because the
// retention sweep keeps freeing space on its own, the block lifts again
// without anyone having to intervene.
//
// Two independent ceilings, either of which can trip:
//   STORAGE_LIMIT_GB   how much of the disk this workspace may occupy (0 = no
//                      quota of its own, only the free-space floor applies)
//   STORAGE_RESERVE_GB how much free disk must remain for everything else
export function createStorage(root, options = {}) {
  const quotaBytes =
    Math.max(0, Number(options.quotaGb ?? process.env.STORAGE_LIMIT_GB ?? 0)) *
    GB;
  const reserveBytes =
    Math.max(
      0.25,
      Number(options.reserveGb ?? process.env.STORAGE_RESERVE_GB ?? 2),
    ) * GB;
  const cacheMs = options.cacheMs ?? 30_000;
  let cached = null,
    measuredAt = 0,
    inFlight = null;
  async function usedBytes(dir, depth = 0) {
    let total = 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 4) total += await usedBytes(file, depth + 1);
      } else {
        const info = await stat(file).catch(() => null);
        if (info) total += info.size;
      }
    }
    return total;
  }
  async function measure() {
    const used = await usedBytes(root);
    // statfs is unavailable on some hosts and filesystems; a workspace quota
    // still protects those, and without either ceiling the answer is "ok"
    // rather than a guess.
    const fs = await statfs(root).catch(() => null);
    const free = fs ? fs.bsize * fs.bavail : null;
    const quotaFull = quotaBytes > 0 && used >= quotaBytes * 0.95;
    const diskFull = free !== null && free <= reserveBytes;
    const quotaLow = quotaBytes > 0 && used >= quotaBytes * 0.8;
    const diskLow = free !== null && free <= reserveBytes * 3;
    const level =
      quotaFull || diskFull ? "full" : quotaLow || diskLow ? "warning" : "ok";
    const room = quotaBytes
      ? `${((quotaBytes - used) / GB).toFixed(1)} GB of the workspace allowance`
      : `${((free ?? 0) / GB).toFixed(1)} GB of disk`;
    return {
      level,
      usedBytes: used,
      freeBytes: free,
      quotaBytes,
      reserveBytes,
      message:
        level === "full"
          ? `Storage is full — only ${room} is left. New imports are paused until videos expire or are deleted.`
          : level === "warning"
            ? `Storage is running low — ${room} is left. Delete finished videos to keep importing.`
            : "",
    };
  }
  return {
    // Measurements are shared and cached: this runs on every import and on
    // every poll from every open tab, and walking the media directory for each
    // of those would cost more than the space it protects.
    async status() {
      if (cached && Date.now() - measuredAt < cacheMs) return cached;
      inFlight ??= measure().finally(() => {
        inFlight = null;
      });
      cached = await inFlight;
      measuredAt = Date.now();
      return cached;
    },
    // Called after anything that frees space, so a paused workspace starts
    // accepting imports again as soon as the sweep has run.
    invalidate() {
      measuredAt = 0;
    },
  };
}
