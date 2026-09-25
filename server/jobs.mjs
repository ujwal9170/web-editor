import { spawn as spawnProcess } from "node:child_process";
import { writeFile, rm } from "node:fs/promises";
import { availableParallelism } from "node:os";
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

// Video rendering is the one job that pins its threads for minutes at a
// stretch, so only one runs at a time whatever the queue's overall limit is.
// A second render waits, but a download or an export acceptance behind it
// still starts -- the limit is on renders, not on the line.
const TYPE_LIMITS = { render: 1 };
// FFmpeg is told how many threads it may use, because left alone it takes
// every core and the box stops answering anything else.
//
// A render gets the whole allowance: it is the job this ceiling exists for, it
// runs on its own, and dividing it further would leave most of the machine
// idle while someone waits on their export. The lighter jobs -- a remux, a wav
// extraction, a thumbnail -- can run two at a time, so they split the same
// allowance between them. A machine small enough that the division lands under
// one thread still gets one: FFmpeg cannot run on less.
export function threadBudget(slots, cores = availableParallelism()) {
  const share = Math.min(
    1,
    Math.max(0.1, Number(process.env.MEDIA_CPU_SHARE) || 0.75),
  );
  return Math.max(1, Math.floor((cores * share) / Math.max(1, slots)));
}

export function createQueue(repo, root, options = {}) {
  const limit = concurrency(options.limit);
  const threads = options.threads ?? threadBudget(limit);
  const renderThreads =
    options.renderThreads ?? options.threads ?? threadBudget(1);
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
      // The worker is told its CPU allowance here rather than working it out
      // for itself: this is the only place that knows how many jobs may be
      // sharing the machine.
      await writeFile(
        specPath,
        JSON.stringify({
          ...payload,
          threads: job.type === "render" ? renderThreads : threads,
        }),
      );
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
        // The running child keeps the loop alive on its own, so this timer
        // does not need to -- and unreferenced it cannot hold a process open
        // for half an hour after the work is done.
        timeout.unref?.();
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
  // A job whose type is already at its own limit is stepped over rather than
  // blocking everything behind it.
  function startable(entry) {
    const cap = TYPE_LIMITS[entry.job.type];
    if (!cap) return true;
    let active = 0;
    for (const other of running)
      if (other.job.type === entry.job.type) active++;
    return active < cap;
  }
  function drain() {
    while (running.size < limit) {
      const index = pending.findIndex(startable);
      if (index < 0) break;
      const [entry] = pending.splice(index, 1);
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
      return {
        limit,
        running: running.size,
        waiting: pending.length,
        threads,
        renderThreads,
      };
    },
  };
}
