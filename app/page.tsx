"use client";
import { useEffect, useState, useRef } from "react";
import dynamic from "next/dynamic";
import {
  Film,
  Download,
  FolderOpen,
  Scissors,
  Sparkles,
  Plus,
  ArrowUpRight,
  LoaderCircle,
  Check,
  Search,
  Upload,
  X,
  Trash2,
  Captions,
  Music2,
  RotateCw,
  AlertCircle,
  LogOut,
  Users,
  KeyRound,
  UserPlus,
  Share2,
  HardDrive,
  Clock3,
} from "lucide-react";
import {
  api,
  fileUrl,
  clock,
  size,
  ago,
  awaitJob,
  LAST_TEMPLATE_KEY,
} from "@/lib/api";
import type {
  Media,
  Project,
  Export,
  Job,
  Template,
  Limits,
} from "@/lib/types";
import DeviceExportQueue from "@/components/DeviceExportQueue";
import { useDeviceExports } from "@/lib/useDeviceExports";
import CaptionPreview from "@/components/CaptionPreview";
import ShareExport from "@/components/ShareExport";
import { rememberedExport, rememberedExportSync } from "@/lib/exportBlobs";
import {
  videoFileName,
  shareVideoFile,
  canShareFiles,
} from "@/shared/file-share.mjs";
import ProjectCard from "@/components/ProjectCard";
import MediaCard from "@/components/MediaCard";
import ExpiryTag from "@/components/ExpiryTag";
import { useAudioModel } from "@/lib/useAudioModel";
import { useWebMCP } from "@/lib/useWebMCP";

// Editor is a large, canvas/WebCodecs-heavy component that most visits
// (browsing Media, Exports, admin) never open -- code-splitting it out of
// the main bundle keeps those far more common pages lighter to load.
const Editor = dynamic(() => import("@/components/Editor"), {
  ssr: false,
  loading: () => (
    <div className="editor-loading">
      <LoaderCircle className="spin" size={28} />
    </div>
  ),
});

type QueueItem = {
  media: Media;
  status: "queued" | "processing" | "done" | "failed";
  detail: string;
};
// One line describing what the server is doing with this account's work. The
// server runs a small number of media jobs at once and everything else waits,
// so a job sitting at 0% needs to say why. The position counts every account's
// work, because that is what the wait actually depends on.
function queueSummary(active: Job[]) {
  const running = active.filter((j) => j.status === "running");
  const waiting = active.filter((j) => j.status === "queued");
  const next = waiting.reduce(
    (best, j) =>
      j.queuePosition && (!best || j.queuePosition < best)
        ? j.queuePosition
        : best,
    0,
  );
  const limit = active.find((j) => j.queueLimit)?.queueLimit ?? 1;
  const parts = [];
  if (running.length)
    parts.push(
      `${running.length} ${running.length === 1 ? "job" : "jobs"} processing (${running[0].type})`,
    );
  if (waiting.length)
    parts.push(
      `${waiting.length} waiting${next ? ` — next is #${next} in line` : ""}`,
    );
  return `${parts.join(" · ")}. The server runs ${limit} at a time; you can keep editing.`;
}
type AdminUser = {
  id: string;
  username: string;
  role: string;
  createdAt: number;
  lastSeenAt: number | null;
  online: boolean;
  mediaCount: number;
  exportCount: number;
  storageBytes: number;
  isSelf: boolean;
};

export default function Studio() {
  const deviceExports = useDeviceExports();
  const [view, setView] = useState("media"),
    [media, setMedia] = useState<Media[]>([]),
    [projects, setProjects] = useState<Project[]>([]),
    [exports, setExports] = useState<Export[]>([]),
    [jobs, setJobs] = useState<Job[]>([]),
    [limits, setLimits] = useState<Limits | null>(null),
    [templates, setTemplates] = useState<Template[]>([]);
  const [project, setProject] = useState<Project | null>(null),
    [query, setQuery] = useState(""),
    [importing, setImporting] = useState(false),
    [url, setUrl] = useState(""),
    // Ticked by default: this workspace is per-account and private, and
    // everyone importing here is bringing in their own footage. The box is
    // still shown (and still untickable) so the declaration is on screen and
    // can be withdrawn, rather than being asserted silently on their behalf.
    [permission, setPermission] = useState(true),
    [shareExport, setShareExport] = useState<Export | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [authed, setAuthed] = useState<boolean | null>(null),
    [username, setUsername] = useState(""),
    [role, setRole] = useState<string | null>(null),
    [users, setUsers] = useState<AdminUser[]>([]),
    [newUser, setNewUser] = useState({ username: "", password: "" }),
    [password, setPassword] = useState(""),
    [caption, setCaption] = useState<Media | null>(null),
    [captionPreview, setCaptionPreview] = useState<Export | null>(null),
    [watch, setWatch] = useState<Export | null>(null),
    [mediaTab, setMediaTab] = useState<"all" | "queue" | "removed">("all"),
    [menuOpen, setMenuOpen] = useState<string | null>(null),
    [queueTick, setQueueTick] = useState(0),
    [editsTab, setEditsTab] = useState<"projects" | "templates">("projects"),
    [templatePicker, setTemplatePicker] = useState<Template | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const queueRef = useRef<QueueItem[]>([]);
  const runningRef = useRef(false);
  useWebMCP(media, authed);
  function bump() {
    setQueueTick((t) => t + 1);
  }
  function addToQueue(item: Media) {
    if (
      queueRef.current.some(
        (q) =>
          q.media.id === item.id &&
          (q.status === "queued" || q.status === "processing"),
      )
    )
      return;
    queueRef.current = [
      ...queueRef.current,
      { media: item, status: "queued", detail: "Waiting…" },
    ];
    setMenuOpen(null);
    bump();
  }
  function removeQueueItem(id: string) {
    queueRef.current = queueRef.current.filter(
      (q) => q.media.id !== id || q.status === "processing",
    );
    bump();
  }
  function retryQueueItem(id: string) {
    const row = queueRef.current.find((q) => q.media.id === id);
    if (row && row.status === "failed") {
      row.status = "queued";
      row.detail = "Waiting…";
      bump();
      runQueue();
    }
  }
  async function runQueue() {
    if (runningRef.current) return;
    runningRef.current = true;
    bump();
    for (;;) {
      const next = queueRef.current.find((q) => q.status === "queued");
      if (!next) break;
      next.status = "processing";
      next.detail = "Reading source audio…";
      bump();
      try {
        const { separateAudio } = await import("@/lib/audio");
        const blob = await separateAudio(
          fileUrl("media", next.media.id, "audioFile"),
          "vocals-only",
          (s) => {
            next.detail = s;
            bump();
          },
          new AbortController().signal,
        );
        next.detail = "Uploading isolated vocals…";
        bump();
        const body = new FormData();
        body.append("file", blob, "processed.wav");
        const { job } = await api(`/media/${next.media.id}/vocal-isolation`, {
          method: "POST",
          body,
        });
        await awaitJob(job.id, (j) => {
          next.detail = `Finishing… ${j.progress || 0}%`;
          bump();
        });
        next.status = "done";
        next.detail = "Instruments removed.";
        bump();
        await refresh();
      } catch (e: any) {
        next.status = "failed";
        next.detail = e.message || "Failed.";
        bump();
      }
    }
    runningRef.current = false;
    bump();
  }
  async function refresh() {
    const [m, p, e, j, t, l] = await Promise.all([
      api<Media[]>("/media"),
      api<Project[]>("/projects"),
      api<Export[]>("/exports"),
      api<Job[]>("/jobs"),
      api<Template[]>("/templates"),
      // Retention and the storage headroom that decides whether new imports
      // are accepted at all; cheap enough to ride along with every poll.
      api<Limits>("/limits"),
    ]);
    setMedia(m);
    setProjects(p);
    setExports(e);
    setJobs(j);
    setTemplates(t);
    setLimits(l);
    return j;
  }
  useEffect(() => {
    api("/auth")
      .then((a) => {
        setAuthed(a.authenticated);
        if (a.username) setUsername(a.username);
        setRole(a.role ?? null);
      })
      .catch((e) => setError(e.message));
  }, []);
  const isAdmin = role === "admin";
  async function refreshUsers() {
    setUsers(await api<AdminUser[]>("/admin/users"));
  }
  useEffect(() => {
    if (!isAdmin || view !== "admin") return;
    refreshUsers().catch((e) => setError(e.message));
    const timer = setInterval(() => refreshUsers().catch(() => {}), 15000);
    return () => clearInterval(timer);
  }, [isAdmin, view]);
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // Poll fast only while something server-side is actually in flight
    // (an import, an export render, isolation) or the on-device instrument
    // queue is running; otherwise back off so an idle tab isn't hitting
    // five endpoints every 2.5s for nothing.
    let pollFailures = 0;
    let showingPollError = false;
    async function tick() {
      try {
        const jobs = await refresh();
        if (cancelled) return;
        pollFailures = 0;
        // Only clear an error THIS loop put up -- never an unrelated one
        // (a failed delete, a failed save) that just happens to still be
        // on screen when a poll succeeds.
        if (showingPollError) {
          setError("");
          showingPollError = false;
        }
        const busy =
          runningRef.current ||
          jobs.some((j) => j.status === "running" || j.status === "queued");
        timer = setTimeout(tick, busy ? 2500 : 9000);
      } catch (e: any) {
        if (cancelled) return;
        // Tolerate one missed poll silently -- a brief server restart or
        // dropped connection shouldn't flash an error for something that
        // resolves on its own a few seconds later.
        if (++pollFailures >= 2) {
          setError(e.message);
          showingPollError = true;
        }
        timer = setTimeout(tick, 9000);
      }
    }
    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [authed]);
  async function attempt(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  // Recent exports are pulled off disk into memory as soon as the list is
  // known, so the share button below has something to hand over the instant
  // it's tapped rather than starting a download at that point.
  useEffect(() => {
    for (const item of exports.slice(0, 3))
      void rememberedExport(item.id).catch(() => {});
  }, [exports]);
  // One tap, no waiting: if this device still holds the file it rendered, the
  // OS share sheet opens from this tap directly. navigator.share() has to run
  // inside the gesture, so the lookup is the synchronous one and the call is
  // the first thing that happens -- anything else here (an await, a setState
  // and its re-render) spends the tap's activation and Android refuses with
  // NotAllowedError. The dialog is the fallback for everything else: an
  // export made elsewhere, one aged out of storage, a browser without file
  // sharing, or a share the browser refuses.
  function shareNow(item: Export) {
    // Desktop can't hand a file to another app at all, so don't attempt it
    // and land on a download nobody asked for -- the dialog says so instead.
    const blob = canShareFiles(navigator)
      ? rememberedExportSync(item.id)
      : null;
    if (!blob) return setShareExport(item);
    try {
      const file = new File([blob], videoFileName(item.name), {
        type: "video/mp4",
      });
      shareVideoFile(navigator, file).catch((error: any) => {
        if (error?.name !== "AbortError") setShareExport(item);
      });
    } catch {
      setShareExport(item);
    }
  }
  function lastTemplateId(): string | undefined {
    try {
      const id = localStorage.getItem(LAST_TEMPLATE_KEY);
      return id && templates.some((t) => t.id === id) ? id : undefined;
    } catch {
      return undefined;
    }
  }
  async function startEditing(item: Media) {
    const templateId = lastTemplateId();
    const p = await api<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({
        mediaId: item.id,
        ...(templateId ? { templateId } : {}),
      }),
    });
    setProject({ ...p, media: item });
    setView("editor");
  }
  async function upload(file?: File) {
    if (!file) return;
    await attempt(async () => {
      const body = new FormData();
      body.append("file", file);
      const { job } = await api("/media/uploads", { method: "POST", body });
      setImporting(false);
      const done = await awaitJob(job.id);
      const list = await api<Media[]>("/media");
      await refresh();
      const item = list.find((m) => m.id === done.resultId);
      if (item) await startEditing(item);
    });
  }
  async function importAndOpen() {
    await attempt(async () => {
      const { job } = await api("/downloads", {
        method: "POST",
        body: JSON.stringify({ url, confirmed: permission }),
      });
      setImporting(false);
      setUrl("");
      const done = await awaitJob(job.id);
      const list = await api<Media[]>("/media");
      await refresh();
      const item = list.find((m) => m.id === done.resultId);
      if (!item)
        throw new Error("Download finished, but the video could not be found.");
      await startEditing(item);
    });
  }
  async function addUser() {
    await attempt(async () => {
      await api("/admin/users", {
        method: "POST",
        body: JSON.stringify(newUser),
      });
      setNewUser({ username: "", password: "" });
      await refreshUsers();
    });
  }
  async function resetUserPassword(u: AdminUser) {
    const next = prompt(`New password for "${u.username}" (min 8 characters):`);
    if (!next) return;
    await attempt(async () => {
      await api(`/admin/users/${u.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: next }),
      });
      await refreshUsers();
      setError("");
    });
  }
  async function removeUser(u: AdminUser) {
    const usage = `${u.mediaCount} video(s), ${u.exportCount} export(s), ${size(u.storageBytes)}`;
    if (
      !confirm(
        `Remove the account "${u.username}"?\n\nThey currently hold ${usage}.\n\nClick OK to continue, then choose whether to delete their files too.`,
      )
    )
      return;
    const alsoDelete = confirm(
      `Delete "${u.username}"'s ${usage} as well?\n\nOK = delete their files and free the space (cannot be undone).\nCancel = keep their files on disk.`,
    );
    await attempt(async () => {
      await api(`/admin/users/${u.id}?deleteContent=${alsoDelete}`, {
        method: "DELETE",
      });
      await refreshUsers();
    });
  }
  async function signOut() {
    deviceExports.clear();
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setAuthed(false);
    setProject(null);
    setMedia([]);
    setProjects([]);
    setExports([]);
    setJobs([]);
    setView("media");
  }
  async function openProject(id: string) {
    await attempt(async () => {
      const p = await api<Project>(`/projects/${id}`);
      setProject(p);
      setView("editor");
    });
  }
  async function editMedia(item: Media) {
    await attempt(() => startEditing(item));
  }
  async function useTemplateWithMedia(template: Template, item: Media) {
    await attempt(async () => {
      const p = await api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ mediaId: item.id, templateId: template.id }),
      });
      try {
        localStorage.setItem(LAST_TEMPLATE_KEY, template.id);
      } catch {}
      setTemplatePicker(null);
      setProject({ ...p, media: item });
      setView("editor");
    });
  }
  async function deleteTemplate(item: Template) {
    if (!confirm(`Delete template "${item.name}"? This cannot be undone.`))
      return;
    await attempt(async () => {
      await api(`/templates/${item.id}`, { method: "DELETE" });
      await refresh();
    });
  }
  const audioModel = useAudioModel(view === "media" && mediaTab === "queue");
  const active = jobs.filter((j) => ["running", "queued"].includes(j.status));
  void queueTick;
  const queue = queueRef.current,
    queuedCount = queue.filter((q) => q.status === "queued").length,
    sourceMedia = media.filter((m) => m.source !== "vocal-isolated"),
    isolatedMedia = media.filter((m) => m.source === "vocal-isolated");
  async function deleteMedia(item: Media) {
    const linked = projects.filter((p) => p.mediaId === item.id);
    const message = linked.length
      ? `Delete "${item.name}" and its ${linked.length} saved edit(s)? This cannot be undone. Exported videos will stay.`
      : `Delete "${item.name}" from Media library? This cannot be undone. Exported videos will stay.`;
    if (!confirm(message)) return;
    await attempt(async () => {
      await api(
        `/media/${item.id}${linked.length ? `?deleteEdits=true&expectedEdits=${linked.length}` : ""}`,
        { method: "DELETE" },
      );
      if (project?.mediaId === item.id) setProject(null);
      await refresh();
    });
  }
  async function deleteProject(item: Project) {
    if (
      !confirm(
        `Delete edit "${item.name}"? Its saved changes and processed audio will be removed. The source video and exported videos will stay. This cannot be undone.`,
      )
    )
      return;
    await attempt(async () => {
      await api(`/projects/${item.id}`, { method: "DELETE" });
      if (project?.id === item.id) setProject(null);
      await refresh();
    });
  }
  if (authed === false)
    return (
      <main className="login">
        <div className="brand">
          <Film /> frame<span>/</span>
        </div>
        <h1>Your editing workspace</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            attempt(async () => {
              const me = await api("/auth", {
                method: "POST",
                body: JSON.stringify({ username, password }),
              });
              setUsername(me.username ?? username);
              setRole(me.role ?? null);
              setPassword("");
              setAuthed(true);
            });
          }}
        >
          <label>
            Username
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button className="primary" disabled={busy}>
            Sign in <ArrowUpRight size={18} />
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  return (
    <div className={`studio${view === "editor" && project ? " editing" : ""}`}>
      <aside className="sidebar">
        <a href="/" className="brand">
          <Film size={26} /> frame<span>/</span>
        </a>
        <span className="eyebrow">WORKSPACE</span>
        <nav>
          {[
            ["media", "Media library", FolderOpen],
            ["editor", "Editor", Scissors],
            ["exports", "Edited videos", Film],
            ...(isAdmin ? [["admin", "People", Users]] : []),
          ].map(([key, label, Icon]: any) => (
            <button
              key={key}
              className={view === key ? "nav active" : "nav"}
              onClick={() => {
                if (key === "editor") setProject(null);
                setView(key);
              }}
            >
              <Icon size={19} />
              {label}
              {key === "media" && <span className="count">{media.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Music2 size={20} />
          <strong>A little less noise.</strong>
          <p>Vocal separation lives right inside your editor.</p>
        </div>
        <div className="workspace-id">
          <span>{(username || "?").slice(0, 1).toUpperCase()}</span>
          <div>
            {username || "Signed in"}
            <small>Your private workspace</small>
          </div>
          <button
            className="sign-out"
            aria-label="Sign out"
            title="Sign out"
            onClick={signOut}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <div className="main">
        <header>
          <div className="crumb">
            Workspace <span>/</span>{" "}
            {view === "media"
              ? "Media library"
              : view === "editor"
                ? "Editor"
                : view === "admin"
                  ? "People"
                  : "Edited videos"}
          </div>
          <div className="header-right">
            <span className="local-label">{username || "Signed in"}</span>
            <button
              className="avatar"
              aria-label={`Sign out${username ? ` (${username})` : ""}`}
              title="Sign out"
              onClick={signOut}
            >
              {(username || "?").slice(0, 1).toUpperCase()}
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="notice error">
            {error}
            <button aria-label="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </button>
          </div>
        )}
        {limits && limits.storage.level !== "ok" && (
          <div
            role="alert"
            className={`notice ${limits.storage.level === "full" ? "error" : "warn"}`}
          >
            <HardDrive size={16} />
            {limits.storage.message}
          </div>
        )}
        {active.length > 0 && (
          <div className="notice">
            <LoaderCircle className="spin" size={16} />
            {queueSummary(active)}
          </div>
        )}
        {view === "admin" && isAdmin ? (
          <section className="library">
            <div className="page-heading">
              <div>
                <div className="eyebrow">WORKSPACE ADMIN</div>
                <h1>People.</h1>
                <p>
                  {users.length} {users.length === 1 ? "account" : "accounts"} ·{" "}
                  {users.filter((u) => u.online).length} online now
                </p>
              </div>
            </div>
            <div className="admin-add">
              <strong>
                <UserPlus size={17} /> Add someone
              </strong>
              <div className="row">
                <label>
                  Username
                  <input
                    value={newUser.username}
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="e.g. ravi"
                    onChange={(e) =>
                      setNewUser({ ...newUser, username: e.target.value })
                    }
                  />
                  {newUser.username.length > 0 &&
                    newUser.username.trim().length < 3 && (
                      <small className="field-hint">
                        At least 3 characters.
                      </small>
                    )}
                </label>
                <label>
                  Password
                  <input
                    type="text"
                    value={newUser.password}
                    placeholder="at least 8 characters"
                    onChange={(e) =>
                      setNewUser({ ...newUser, password: e.target.value })
                    }
                  />
                  {newUser.password.length > 0 &&
                    newUser.password.length < 8 && (
                      <small className="field-hint">
                        {8 - newUser.password.length} more character
                        {8 - newUser.password.length === 1 ? "" : "s"} needed.
                      </small>
                    )}
                </label>
              </div>
              <button
                className="primary wide"
                disabled={
                  busy ||
                  newUser.username.trim().length < 3 ||
                  newUser.password.length < 8
                }
                onClick={addUser}
              >
                Create account
              </button>
              {(newUser.username.trim().length >= 3 ||
                newUser.password.length > 0) &&
                (newUser.username.trim().length < 3 ||
                  newUser.password.length < 8) && (
                  <p className="field-hint">
                    Fill in both fields above to enable Create account.
                  </p>
                )}
              <p className="hint">
                New accounts are ordinary members. Admin rights are granted only
                from the command line (`pnpm user promote &lt;name&gt;`), so a
                stolen admin session cannot create more admins.
              </p>
            </div>
            <div className="admin-list">
              {users.map((u) => (
                <div className="admin-row" key={u.id}>
                  <span
                    className={`presence ${u.online ? "online" : ""}`}
                    aria-hidden="true"
                  />
                  <div className="admin-row-body">
                    <h3>
                      {u.username}
                      {u.role === "admin" && (
                        <span className="role-tag">admin</span>
                      )}
                      {u.isSelf && <span className="role-tag">you</span>}
                    </h3>
                    <p>
                      {u.online
                        ? "Online now"
                        : u.lastSeenAt
                          ? `Last seen ${new Date(u.lastSeenAt).toLocaleString()}`
                          : "Never signed in"}{" "}
                      · {u.mediaCount} video{u.mediaCount === 1 ? "" : "s"} ·{" "}
                      {size(u.storageBytes)}
                    </p>
                  </div>
                  <button
                    className="subtle compact"
                    title="Set a new password"
                    onClick={() => resetUserPassword(u)}
                  >
                    <KeyRound size={15} />
                  </button>
                  <button
                    className="subtle compact"
                    title={
                      u.isSelf
                        ? "You cannot remove your own account"
                        : "Remove account"
                    }
                    disabled={busy || u.isSelf}
                    onClick={() => removeUser(u)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            <p className="hint">
              Admins manage accounts only — nobody, including you, can open
              another person's videos or edits from here.
            </p>
          </section>
        ) : view === "editor" && project ? (
          <Editor
            // mediaId is in the key so replacing which video a project
            // edits remounts the Editor fresh -- its internal state (edit,
            // name, caption, revision, video/canvas refs) is only ever
            // initialized once from `initial`, so a swap needs a clean
            // instance rather than trying to reconcile everything live.
            key={`${project.id}-${project.mediaId}`}
            initial={project}
            onError={setError}
            onQueue={deviceExports.enqueue}
            onSaved={(p) => setProject(p)}
            onBack={() => setProject(null)}
            onDelete={() => deleteProject(project)}
          />
        ) : (
          <section className="library">
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR CREATIVE DESK</div>
                <h1>
                  {view === "media"
                    ? mediaTab === "all"
                      ? "Start a new video."
                      : "All your footage."
                    : view === "exports"
                      ? "Ready for the feed."
                      : "Pick up where you left off."}
                </h1>
                <p>
                  {view === "media"
                    ? mediaTab === "all"
                      ? "Everything else you've brought in lives in the tabs below."
                      : "Bring a clip in. Make it yours."
                    : view === "exports"
                      ? "Your finished edits, with captions saved alongside."
                      : "Open a saved project or start with a clip from Media."}
                </p>
                {limits && (
                  <p className="retention-note">
                    <Clock3 size={14} />
                    {view === "exports"
                      ? `Exports are deleted ${limits.retentionHours} hours after they are saved. Download anything you need to keep.`
                      : view === "editor"
                        ? `An edit stops working once its source is deleted, ${limits.retentionHours} hours after it was imported. Reopening it does not extend that.`
                        : `Imported videos are deleted ${limits.retentionHours} hours after they arrive. Opening or editing one does not extend that.`}
                  </p>
                )}
              </div>
              {!(view === "media" && mediaTab === "all") && (
                <button className="primary" onClick={() => setImporting(true)}>
                  <Plus size={18} /> Import video
                </button>
              )}
            </div>
            {view === "media" && mediaTab === "all" && (
              <div
                className="import-hero"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  upload(e.dataTransfer.files[0]);
                }}
              >
                <div className="import-icon">
                  <Download size={28} />
                </div>
                <h2>Bring your footage in.</h2>
                <p>
                  Paste a public Instagram, YouTube or TikTok video link.
                  Once it's downloaded, the editor opens automatically. Up to
                  15 minutes and 300 MB.
                </p>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    importAndOpen();
                  }}
                >
                  <label>
                    Video link
                    <input
                      type="url"
                      required
                      placeholder="Instagram, YouTube or TikTok URL"
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={permission}
                      onChange={(e) => setPermission(e.target.checked)}
                      required
                    />
                    I own this content or have permission to use it.
                  </label>
                  <button className="primary" disabled={busy}>
                    {busy ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Download size={18} />
                    )}{" "}
                    Download &amp; open editor
                  </button>
                </form>
                <div className="divider">or</div>
                <button
                  className="subtle wide"
                  onClick={() => input.current?.click()}
                  disabled={busy}
                >
                  <Upload size={18} /> Upload from device
                </button>
              </div>
            )}
            <div className="toolbar">
              <div className="tabs">
                {view === "media" ? (
                  <>
                    <button
                      className={mediaTab === "all" ? "selected" : ""}
                      onClick={() => setMediaTab("all")}
                    >
                      New video
                    </button>
                    <button
                      className={mediaTab === "queue" ? "selected" : ""}
                      onClick={() => setMediaTab("queue")}
                    >
                      Instrument Remover <span>{queue.length}</span>
                    </button>
                    <button
                      className={mediaTab === "removed" ? "selected" : ""}
                      onClick={() => setMediaTab("removed")}
                    >
                      Instruments removed <span>{isolatedMedia.length}</span>
                    </button>
                  </>
                ) : view === "editor" ? (
                  <>
                    <button
                      className={editsTab === "projects" ? "selected" : ""}
                      onClick={() => setEditsTab("projects")}
                    >
                      Projects <span>{projects.length}</span>
                    </button>
                    <button
                      className={editsTab === "templates" ? "selected" : ""}
                      onClick={() => setEditsTab("templates")}
                    >
                      Templates <span>{templates.length}</span>
                    </button>
                  </>
                ) : (
                  <button className="selected">
                    Exports <span>{exports.length}</span>
                  </button>
                )}
              </div>
              {!(view === "media" && mediaTab === "all") && (
                <label className="search">
                  <Search size={17} />
                  <input
                    aria-label="Search videos"
                    placeholder="Search videos…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                </label>
              )}
            </div>
            {view === "media" && mediaTab === "queue" ? (
              <div className="queue-panel">
                <div className="queue-toolbar">
                  <div>
                    <strong>Pick a clip</strong>
                    <p>Use a clip's ⋯ menu to add it to the removal queue.</p>
                  </div>
                </div>
                <div className="media-grid queue-pick-grid">
                  {sourceMedia
                    .filter((m) =>
                      m.name.toLowerCase().includes(query.toLowerCase()),
                    )
                    .map((m) => (
                      <MediaCard
                        key={m.id}
                        media={m}
                        busy={busy}
                        onOpen={() => editMedia(m)}
                        onCaption={() => setCaption(m)}
                        onDelete={() => deleteMedia(m)}
                        queueMenu={{
                          open: menuOpen === m.id,
                          queued: queue.some(
                            (q) =>
                              q.media.id === m.id &&
                              (q.status === "queued" ||
                                q.status === "processing"),
                          ),
                          onToggle: () =>
                            setMenuOpen(menuOpen === m.id ? null : m.id),
                          onAdd: () => addToQueue(m),
                        }}
                      />
                    ))}
                  {sourceMedia.length === 0 && (
                    <p className="empty">
                      No clips yet — import one from New video.
                    </p>
                  )}
                </div>
                <hr />
                {audioModel && !audioModel.available && (
                  <div role="alert" className="notice error">
                    <AlertCircle size={16} />
                    {audioModel.detail}
                  </div>
                )}
                <div className="queue-toolbar">
                  <div>
                    <strong>
                      {queue.length} file{queue.length === 1 ? "" : "s"} in
                      queue
                    </strong>
                    <p>Processed one at a time — never in parallel.</p>
                  </div>
                  <button
                    className="primary"
                    disabled={
                      !queuedCount ||
                      runningRef.current ||
                      audioModel?.available === false
                    }
                    onClick={() => runQueue()}
                  >
                    {runningRef.current ? (
                      <LoaderCircle className="spin" size={18} />
                    ) : (
                      <Music2 size={18} />
                    )}
                    Remove All
                  </button>
                </div>
                {queue.length === 0 ? (
                  <div className="empty">
                    <Music2 size={36} />
                    <h2>Nothing queued yet.</h2>
                    <p>Add a clip above using its ⋯ menu.</p>
                  </div>
                ) : (
                  <div className="queue-list">
                    {queue.map((q) => (
                      <div className="queue-row" key={q.media.id}>
                        <img
                          src={fileUrl("media", q.media.id, "thumbnail")}
                          alt=""
                          loading="lazy"
                          decoding="async"
                        />
                        <div className="queue-row-body">
                          <h3>{q.media.name}</h3>
                          <p>{q.detail || "Waiting…"}</p>
                        </div>
                        <span className={`queue-status ${q.status}`}>
                          {q.status === "queued" && "Queued"}
                          {q.status === "processing" && (
                            <LoaderCircle className="spin" size={15} />
                          )}
                          {q.status === "done" && <Check size={15} />}
                          {q.status === "failed" && <AlertCircle size={15} />}
                        </span>
                        {q.status === "queued" && (
                          <button
                            aria-label={`Remove ${q.media.name} from queue`}
                            onClick={() => removeQueueItem(q.media.id)}
                          >
                            <X size={16} />
                          </button>
                        )}
                        {q.status === "failed" && (
                          <button
                            aria-label={`Retry ${q.media.name}`}
                            onClick={() => retryQueueItem(q.media.id)}
                          >
                            <RotateCw size={16} />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
            <div className="media-grid">
              {view === "media" &&
                mediaTab === "removed" &&
                isolatedMedia
                  .filter((m) =>
                    m.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((m) => (
                    <MediaCard
                      key={m.id}
                      media={m}
                      busy={busy}
                      onOpen={() => editMedia(m)}
                      onCaption={() => setCaption(m)}
                      onDelete={() => deleteMedia(m)}
                    />
                  ))}
              {view === "editor" &&
                editsTab === "projects" &&
                projects
                  .filter((p) =>
                    p.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((p) => (
                    <ProjectCard
                      key={p.id}
                      project={p}
                      media={media.find((m) => m.id === p.mediaId)}
                      busy={busy}
                      onOpen={() => openProject(p.id)}
                      onDelete={() => deleteProject(p)}
                    />
                  ))}
              {view === "editor" &&
                editsTab === "templates" &&
                templates
                  .filter((t) =>
                    t.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((t) => (
                    <article className="media-card template-card" key={t.id}>
                      <button
                        className="thumbnail template-swatch"
                        style={{
                          background:
                            t.edit.canvas.background.colors[0] ?? "#111827",
                        }}
                        onClick={() => setTemplatePicker(t)}
                      >
                        <span className="template-card-name">{t.name}</span>
                      </button>
                      <div className="row">
                        <span className="grow">
                          {t.edit.textOverlays.length} text ·{" "}
                          {Math.round(t.edit.crop.width * 100)}%×
                          {Math.round(t.edit.crop.height * 100)}% crop
                        </span>
                        <button
                          aria-label={`Delete template ${t.name}`}
                          onClick={() => deleteTemplate(t)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </article>
                  ))}
              {view === "editor" &&
                editsTab === "templates" &&
                templates.length === 0 && (
                  <p className="empty">
                    No templates yet -- long-press a video in the editor and
                    choose "Save as template".
                  </p>
                )}
              {view === "exports" &&
                exports
                  .filter((x) =>
                    x.name.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((x) => (
                    <article className="media-card" key={x.id}>
                      <button className="thumbnail" onClick={() => setWatch(x)}>
                        <img
                          src={fileUrl("export", x.id, "thumbnail")}
                          alt={x.name}
                          loading="lazy"
                          decoding="async"
                        />
                        <span className="source-tag finished">
                          <Check size={12} /> Exported
                        </span>
                        <span className="duration">{clock(x.duration)}</span>
                      </button>
                      <div className="card-body">
                        <h3>{x.name}</h3>
                        <p className="caption-preview">
                          {x.caption || "No caption added"}
                        </p>
                        <div className="card-footer">
                          <span>
                            {ago(x.createdAt)} · {size(x.size)}
                            {x.expiresAt ? " · " : ""}
                            <ExpiryTag at={x.expiresAt} />
                          </span>
                          <div>
                            <button
                              title="Preview caption"
                              aria-label={`Preview caption for ${x.name}`}
                              onClick={() => setCaptionPreview(x)}
                            >
                              <Captions size={18} />
                            </button>
                            <a
                              title="Download MP4"
                              href={fileUrl("export", x.id, "file", true)}
                            >
                              <Download size={18} />
                            </a>
                            <button
                              title="Share video file"
                              aria-label={`Share ${x.name} as a video file`}
                              onClick={() => shareNow(x)}
                            >
                              <Share2 size={18} />
                            </button>
                            <button
                              aria-label="Delete export"
                              onClick={() => {
                                if (
                                  confirm(
                                    "Delete this export? Your source and project will stay.",
                                  )
                                )
                                  attempt(async () => {
                                    await api(`/exports/${x.id}`, {
                                      method: "DELETE",
                                    });
                                    await refresh();
                                  });
                              }}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </article>
                  ))}
            </div>
            )}
            {view !== "media" &&
              !(view === "exports" ? exports : projects).length && (
                <div className="empty">
                  <Film size={36} />
                  <h2>
                    {view === "exports"
                      ? "Your next edit belongs here."
                      : "Start with a video."}
                  </h2>
                  <p>
                    {view === "exports"
                      ? "Export a project to save your finished video and caption."
                      : "Choose a clip from the Media library to begin."}
                  </p>
                  <button className="subtle" onClick={() => setView("media")}>
                    Go to Media <ArrowUpRight size={16} />
                  </button>
                </div>
              )}
            {view === "media" && mediaTab === "removed" && !isolatedMedia.length && (
              <div className="empty">
                <Music2 size={36} />
                <h2>No instrument-removed clips yet.</h2>
                <p>Run the Instrument Remover queue to see results here.</p>
                <button className="subtle" onClick={() => setMediaTab("queue")}>
                  Go to Instrument Remover <ArrowUpRight size={16} />
                </button>
              </div>
            )}
            {jobs.some((j) => j.status === "failed") && (
              <details className="job-errors">
                <summary>Recent processing issues</summary>
                {jobs
                  .filter((j) => j.status === "failed")
                  .slice(0, 5)
                  .map((j) => (
                    <p key={j.id}>
                      {j.type}: {j.error}
                    </p>
                  ))}
              </details>
            )}
          </section>
        )}
      </div>
      {!(view === "editor" && project) && (
        <nav className="mobile-nav" aria-label="Sections">
          {[
            ["media", "Media", FolderOpen],
            ["editor", "Edits", Scissors],
            ["exports", "Videos", Film],
            ...(isAdmin ? [["admin", "People", Users]] : []),
          ].map(([key, label, Icon]: any) => (
            <button
              key={key}
              className={view === key ? "active" : ""}
              onClick={() => {
                if (key === "editor") setProject(null);
                setView(key);
              }}
            >
              <Icon size={22} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
      <input
        ref={input}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(e) => {
          upload(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
      {menuOpen && (
        <div className="menu-overlay" onClick={() => setMenuOpen(null)} />
      )}
      {importing && (
        <div className="modal-backdrop">
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Import video"
            className="modal"
          >
            <button
              className="close"
              aria-label="Close import"
              onClick={() => setImporting(false)}
            >
              <X />
            </button>
            <div className="modal-icon">
              <Download />
            </div>
            <h2>Bring your footage in.</h2>
            <p>
              Paste a public Instagram, YouTube or TikTok video link, or upload
              a video. Up to 15 minutes and 300 MB.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                attempt(async () => {
                  await api("/downloads", {
                    method: "POST",
                    body: JSON.stringify({ url, confirmed: permission }),
                  });
                  setImporting(false);
                  setUrl("");
                  await refresh();
                });
              }}
            >
              <label>
                Video link
                <input
                  type="url"
                  required
                  placeholder="Instagram, YouTube or TikTok URL"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={permission}
                  onChange={(e) => setPermission(e.target.checked)}
                  required
                />
                I own this content or have permission to use it.
              </label>
              <button className="primary" disabled={busy}>
                {busy ? (
                  <LoaderCircle className="spin" size={18} />
                ) : (
                  <Download size={18} />
                )}{" "}
                Import to Media
              </button>
            </form>
            <div className="divider">or</div>
            <button
              className="subtle wide"
              onClick={() => input.current?.click()}
              disabled={busy}
            >
              <Upload size={18} /> Upload from device
            </button>
            {error && (
              <p role="alert" className="inline-error">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
      {caption && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Edit caption"
          >
            <button
              className="close"
              aria-label="Close caption"
              onClick={() => setCaption(null)}
            >
              <X />
            </button>
            <h2>Original caption</h2>
            <label>
              Video name
              <input
                value={caption.name}
                onChange={(e) =>
                  setCaption({ ...caption, name: e.target.value })
                }
              />
            </label>
            <label>
              Caption
              <textarea
                rows={8}
                value={caption.caption}
                onChange={(e) =>
                  setCaption({ ...caption, caption: e.target.value })
                }
              />
            </label>
            <button
              className="primary"
              onClick={() =>
                attempt(async () => {
                  await api(`/media/${caption.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({
                      name: caption.name,
                      caption: caption.caption,
                    }),
                  });
                  setCaption(null);
                  await refresh();
                })
              }
            >
              Save caption
            </button>
          </section>
        </div>
      )}
      <DeviceExportQueue rows={deviceExports.rows} cancel={deviceExports.cancel} dismiss={deviceExports.dismiss}
        openExports={() => { setView("exports"); void refresh(); }} />
      {captionPreview && (
        <CaptionPreview
          key={captionPreview.id}
          item={captionPreview}
          onClose={() => setCaptionPreview(null)}
        />
      )}
      {shareExport && (
        <ShareExport
          key={shareExport.id}
          item={shareExport}
          onClose={() => setShareExport(null)}
        />
      )}
      {watch && (
        <div className="modal-backdrop">
          <section
            className="modal video-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Preview export"
          >
            <button
              className="close"
              aria-label="Close preview"
              onClick={() => setWatch(null)}
            >
              <X />
            </button>
            <video src={fileUrl("export", watch.id)} controls autoPlay />
            <h3>{watch.name}</h3>
            <p>{watch.caption}</p>
          </section>
        </div>
      )}
      {templatePicker && (
        <div
          className="modal-backdrop"
          onClick={() => !busy && setTemplatePicker(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Start from template"
            className="modal media-picker"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Use "{templatePicker.name}" with</h2>
            <p className="hint">
              Pick a clip -- crop, text and background from the template
              apply to it, sized to its own length.
            </p>
            {sourceMedia.filter((m) => m.status === "ready").length === 0 ? (
              <p className="empty">No ready clips in Media yet.</p>
            ) : (
              <div className="media-picker-grid">
                {sourceMedia
                  .filter((m) => m.status === "ready")
                  .map((m) => (
                    <button
                      key={m.id}
                      className="media-picker-item"
                      disabled={busy}
                      onClick={() => useTemplateWithMedia(templatePicker, m)}
                    >
                      <img
                        src={fileUrl("media", m.id, "thumbnail")}
                        alt={m.name}
                        loading="lazy"
                        decoding="async"
                      />
                      <span>{m.name}</span>
                    </button>
                  ))}
              </div>
            )}
            <button
              className="wide subtle"
              disabled={busy}
              onClick={() => setTemplatePicker(null)}
            >
              Cancel
            </button>
          </section>
        </div>
      )}
    </div>
  );
}
