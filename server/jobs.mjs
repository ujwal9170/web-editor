import { spawn as spawnProcess } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import path from "node:path";

// How many media jobs the box runs at once. Two by default: a long yt-dlp
// download no longer holds up a short export acceptance behind it, while the
// machine keeps enough CPU for the browsers doing the actual rendering.
// Everything past the limit waits its turn in arrival order and can say where
// in the line it is.
function concurrency(requested) {
  return Math.min(
    4,
    Math.max(1, Number(requested || process.env.MEDIA_JOB_CONCURRENCY) || 2),
  );
}

export function createQueue(repo, root, options = {}) {
  const limit = concurrency(options.limit);
  const spawn = options.spawn || spawnProcess;
  const pending = [];
  const running = new Set();
  const python = process.env.PYTHON || "python";
  const worker = path.resolve("worker/media.py");
  for (const job of repo.list("job"))
    if (["queued", "running"].includes(job.status))
      repo.put("job", {
        ...job,
        status: "failed",
        error: "Server restarted. Please submit this operation again.",
      });
  async function run(entry) {
    const { job, payload, done, failed } = entry;
    const specPath = path.join(root, `${job.id}.job.json`);
    try {
      repo.put("job", { ...job, status: "running", progress: 5 });
      await writeFile(specPath, JSON.stringify(payload));
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(python, [worker, specPath], {
          windowsHide: true,
          env: { ...process.env, NODE_BINARY: process.execPath },
        });
        let output = "",
          error = "";
        const timeout = setTimeout(() => {
          proc.kill();
          reject(new Error("Processing timed out. Try a shorter video."));
        }, 30 * 60_000);
        proc.stdout.on("data", (b) => {
          output = (output + b).slice(-100_000);
        });
        proc.stderr.on("data", (b) => {
          error = (error + b).slice(-3000);
        });
        proc.on("error", (e) => {
          clearTimeout(timeout);
          reject(e);
        });
        proc.on("close", (code) => {
          clearTimeout(timeout);
          if (code !== 0)
            reject(new Error(error || "Media processing failed."));
          else {
            try {
              resolve(JSON.parse(output.trim().split("\n").at(-1)));
            } catch {
              reject(new Error("Invalid worker response"));
            }
          }
        });
      });
      const resultId = await done(result);
      repo.put("job", { ...job, status: "ready", progress: 100, resultId });
    } catch (e) {
      await failed?.();
      repo.put("job", {
        ...job,
        status: "failed",
        error: String(e.message).slice(-1200),
        progress: 0,
      });
    } finally {
      await rm(specPath, { force: true });
      running.delete(entry);
      drain();
    }
  }
  function drain() {
    while (running.size < limit && pending.length) {
      const entry = pending.shift();
      running.add(entry);
      void run(entry);
    }
  }
  return {
    add(type, payload, done, failed) {
      const job = repo.put("job", {
        type,
        status: "queued",
        progress: 0,
        projectId: payload.projectId,
        mediaId: payload.mediaId,
        userId: payload.userId,
      });
      pending.push({ job, payload, done, failed });
      drain();
      return job;
    },
    // 1 means "next to start"; 0 means the job is not waiting (it is already
    // running, or it finished).
    position(id) {
      return pending.findIndex((entry) => entry.job.id === id) + 1;
    },
    stats() {
      return { limit, running: running.size, waiting: pending.length };
    },
  };
}
