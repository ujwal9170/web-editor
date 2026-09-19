"use client";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import Slider from "@/components/Slider";
import CustomColor from "@/components/CustomColor";
import { useEditorViewport } from "@/lib/useEditorViewport";
import {
  Play,
  Pause,
  Scissors,
  Trash2,
  Undo2,
  Redo2,
  Download,
  Crop,
  Type,
  Palette,
  Music2,
  Captions,
  Plus,
  LoaderCircle,
  Save,
  ChevronDown,
  ChevronLeft,
  Smartphone,
  X,
  Grid3x3,
  RotateCcw,
  Check,
  RefreshCw,
  LayoutTemplate,
  Minus,
  Droplet,
  Copy,
  Maximize2,
  Minimize2,
} from "lucide-react";
// Only the editor's Text tab ever renders these -- loaded here instead of
// the root layout so pages that never open the editor never pay for them.
import "@fontsource/dm-sans/700.css";
import "@fontsource/montserrat/700.css";
import "@fontsource/roboto/700.css";
import { api, fileUrl, clock, awaitJob, LAST_TEMPLATE_KEY } from "@/lib/api";
import { cropGeometry } from "@/shared/export.mjs";
import {
  preview,
  fonts,
  textColors,
  bgColors,
  dimensions,
  clampCrop,
  MIN_CROP,
  MIN_BLUR,
  MIN_BLUR_WIDTH,
  SAFE_ZONE,
  measureOverlay,
  type Crop as CropRect,
} from "@/lib/canvas";
import type {
  Edit,
  Media,
  Overlay,
  Project,
  Template,
  BlurRegion,
} from "@/lib/types";
import type { ExportTask } from "@/lib/useDeviceExports";

export default function Editor({
  initial,
  onError,
  onQueue,
  onSaved,
  onBack,
  onDelete,
}: {
  initial: Project;
  onError: (e: string) => void;
  onQueue: (task: ExportTask) => Promise<void>;
  onSaved: (p: Project) => void;
  onBack?: () => void;
  onDelete?: () => void;
}) {
  const editorRoot = useRef<HTMLElement>(null);
  const toolBody = useRef<HTMLDivElement>(null);
  function endTextInput() {
    const active = document.activeElement;
    if (active instanceof HTMLElement && editorRoot.current?.contains(active)) active.blur();
    editorRoot.current?.classList.remove("keyboard-editing");
  }
  useEditorViewport(editorRoot);
  const [edit, setEdit] = useState<Edit>(initial.edit),
    [name, setName] = useState(initial.name),
    [caption, setCaption] = useState(initial.caption),
    [tab, setTab] = useState("crop"),
    [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [selected, setSelected] = useState(0),
    [saving, setSaving] = useState("Saved"),
    [rendering, setRendering] = useState(false);
  const [past, setPast] = useState<Edit[]>([]),
    [future, setFuture] = useState<Edit[]>([]),
    [audioStatus, setAudioStatus] = useState(""),
    [separating, setSeparating] = useState(false),
    [stem, setStem] = useState<{
      url: string;
      blob: Blob;
      mode: string;
    } | null>(null),
    [quality, setQuality] = useState<"1080p" | "720p">("1080p"),
    [exportMenuOpen, setExportMenuOpen] = useState(false),
    [sheetOpen, setSheetOpen] = useState(false),
    [deviceSupported, setDeviceSupported] = useState(false),
    [freehand, setFreehand] = useState(false),
    [liveCrop, setLiveCrop] = useState<CropRect | null>(null),
    [liveBlur, setLiveBlur] = useState<BlurRegion | null>(null),
    [liveTextPos, setLiveTextPos] = useState<{
      id: string;
      x: number;
      y: number;
    } | null>(null),
    [selectedTextId, setSelectedTextId] = useState<string | null>(null),
    [videoSelected, setVideoSelected] = useState(false),
    [blurSelected, setBlurSelected] = useState(false),
    [fullscreenPreview, setFullscreenPreview] = useState(false),
    [liveVideoZoom, setLiveVideoZoom] = useState<number | null>(null),
    [videoMenuOpen, setVideoMenuOpen] = useState(false),
    [mediaPicker, setMediaPicker] = useState<Media[] | null>(null),
    [replacing, setReplacing] = useState(false),
    [templateStripOpen, setTemplateStripOpen] = useState(false),
    [templates, setTemplates] = useState<Template[] | null>(null);
  const video = useRef<HTMLVideoElement>(null),
    derived = useRef<HTMLAudioElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    textFrame = useRef<HTMLDivElement>(null),
    panGuideX = useRef<HTMLSpanElement>(null),
    panGuideY = useRef<HTMLSpanElement>(null),
    longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    longPressStart = useRef<{ x: number; y: number } | null>(null),
    current = useRef(edit),
    revision = useRef(initial.revision),
    saveChain = useRef<Promise<any>>(Promise.resolve()),
    abort = useRef<AbortController | null>(null),
    alive = useRef(true);
  // Live reposition drag on the composited preview (see panDown below).
  // Kept off React state entirely -- read straight from the draw loop -- so
  // 60fps pointermove never touches the undo stack or autosave; only
  // pointerup commits a single change().
  const liveBlurRef = useRef<BlurRegion | null>(null),
    liveOffset = useRef<{ x: number; y: number } | null>(null),
    panDrag = useRef<{
      startX: number;
      startY: number;
      startOffsetX: number;
      startOffsetY: number;
      boxWidthPx: number;
      boxHeightPx: number;
      moved: boolean;
      allowed: boolean;
    } | null>(null);
  const videoPointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number; value: number } | null>(null);
  const liveZoomRef = useRef<number | null>(null);
  useEffect(() => {
    const element = canvas.current, stage = element?.parentElement;
    if (!element || !stage) return;
    const measure = () => {
      const rect = element.getBoundingClientRect(), parent = stage.getBoundingClientRect();
      stage.style.setProperty("--composition-left", `${rect.left - parent.left - stage.clientLeft}px`);
      stage.style.setProperty("--composition-top", `${rect.top - parent.top - stage.clientTop}px`);
      stage.style.setProperty("--composition-width", `${rect.width}px`);
      stage.style.setProperty("--composition-height", `${rect.height}px`);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element); observer.observe(stage); measure();
    return () => observer.disconnect();
  }, [fullscreenPreview, freehand]);
  useEffect(() => {
    const handleFullscreen = () => {
      if (!document.fullscreenElement) setFullscreenPreview(false);
    };
    document.addEventListener("fullscreenchange", handleFullscreen);
    return () => document.removeEventListener("fullscreenchange", handleFullscreen);
  }, []);
  const media = initial.media!,
    duration = media.duration;
  // Where the video itself actually draws on the 9:16 canvas right now --
  // shrinks/shifts as the crop changes. Used to size the pan-drag hit area
  // to just the video, not the full canvas (which can include background
  // showing through a crop).
  const [previewCanvasWidth, previewCanvasHeight] = dimensions(
    edit.canvas.aspectRatio,
  );
  const videoRect =
    media.width && media.height
      ? cropGeometry(
          { ...edit.crop, zoom: liveVideoZoom ?? edit.crop.zoom },
          media.width,
          media.height,
          previewCanvasWidth,
          previewCanvasHeight,
        )
      : null;
  const latest = useRef({ edit, name, caption });
  latest.current = { edit, name, caption };
  const committed = useRef(
    JSON.stringify({
      edit: initial.edit,
      name: initial.name,
      caption: initial.caption,
    }),
  );
  current.current = edit;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      abort.current?.abort();
      const snapshot = latest.current;
      if (JSON.stringify(snapshot) !== committed.current) {
        saveChain.current = saveChain.current
          .catch(() => {})
          .then(async () => {
            if (JSON.stringify(snapshot) === committed.current) return;
            const p = await api<Project>(`/projects/${initial.id}`, {
              method: "PATCH",
              body: JSON.stringify({ ...snapshot, revision: revision.current }),
            });
            revision.current = p.revision;
            committed.current = JSON.stringify(snapshot);
          })
          .catch((e) => onError(e.message));
      }
    };
  }, []);
  useEffect(
    () => () => {
      if (stem) URL.revokeObjectURL(stem.url);
    },
    [stem],
  );
  useEffect(() => {
    import("@/lib/deviceExport").then(({ deviceExportSupported }) =>
      setDeviceSupported(deviceExportSupported()),
    );
  }, []);
  useEffect(() => {
    // Each tool starts at its own header, not the previous text card's scroll offset.
    if (toolBody.current) toolBody.current.scrollTop = 0;
  }, [tab, sheetOpen]);
  function change(next: Edit) {
    setPast((p) => [...p.slice(-59), edit]);
    setFuture([]);
    setEdit(next);
  }
  // Leaving Free hand (Done, closing the sheet, switching tools) must never
  // silently drop a drag that was still in flight -- flush whatever was last
  // on screen into the real edit first, so what you saw is what you get.
  function exitFreehand() {
    setLiveCrop((c) => {
      if (c) change({ ...edit, crop: c });
      return null;
    });
    setFreehand(false);
  }
  // Shared by the sheet's own close button and a tap on the blank preview
  // area outside it -- exitFreehand() already flushes any in-flight
  // freehand drag into a real change() before closing, so nothing dragged
  // right before closing is ever silently lost.
  function closeSheet() {
    setTab("");
    endTextInput();
    setSheetOpen(false);
    exitFreehand();
    setLiveTextPos(null);
    setSelectedTextId(null);
  }
  // Long-press on the video opens a small "delete or replace this clip"
  // menu. Lives on the preview stage itself (bubble phase), same as the
  // outside-tap-close handler above -- so it naturally doesn't fire when
  // the press starts on an interactive child that already stops
  // propagation (crop-pan drag target, text handles, freehand's own
  // handles), since a long-press there is that tool's own gesture, not a
  // request to manage the video itself.
  const LONG_PRESS_MS = 550,
    LONG_PRESS_MOVE_TOLERANCE = 10;
  function startLongPress(e: ReactPointerEvent<HTMLDivElement>) {
    longPressStart.current = { x: e.clientX, y: e.clientY };
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      setVideoMenuOpen(true);
    }, LONG_PRESS_MS);
  }
  function moveLongPress(e: ReactPointerEvent<HTMLDivElement>) {
    const start = longPressStart.current;
    if (!start || !longPressTimer.current) return;
    if (
      Math.hypot(e.clientX - start.x, e.clientY - start.y) >
      LONG_PRESS_MOVE_TOLERANCE
    )
      cancelLongPress();
  }
  function cancelLongPress() {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressStart.current = null;
  }
  async function openMediaPicker() {
    setVideoMenuOpen(false);
    try {
      const all = await api<Media[]>("/media");
      setMediaPicker(
        all.filter(
          (m) => m.id !== initial.media!.id && m.status === "ready",
        ),
      );
    } catch (e: any) {
      onError(e.message);
    }
  }
  // Saves just the reusable part of the current edit -- crop, background,
  // text styling/position, none of it tied to this specific clip's timeline
  // or duration (see templateEditSchema in shared/validation.mjs).
  async function saveAsTemplate() {
    setVideoMenuOpen(false);
    const name = prompt("Name this template:");
    if (!name?.trim()) return;
    try {
      const t = await api<Template>("/templates", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          edit: {
            canvas: edit.canvas,
            crop: edit.crop,
            textOverlays: edit.textOverlays.map(
              ({ startMs, endMs, ...rest }) => rest,
            ),
          },
        }),
      });
      setTemplates((cur) => (cur ? [...cur, t] : cur));
    } catch (e: any) {
      onError(e.message);
    }
  }
  function toggleTemplateStrip() {
    endTextInput();
    const next = !templateStripOpen;
    setTemplateStripOpen(next);
    if (!next) return;
    // Opening the strip retires whatever tool panel was showing (Crop's
    // included) rather than floating on top of it -- on desktop that panel
    // has no "closed" state of its own (it's always visible, switching only
    // by tab), so hiding it while the strip is open is handled purely by
    // the .inspector.template-open CSS rule below.
    setSheetOpen(false);
    exitFreehand();
    setLiveTextPos(null);
    setSelectedTextId(null);
    if (templates === null)
      api<Template[]>("/templates")
        .then(setTemplates)
        .catch((e) => onError(e.message));
  }
  // Applies a template's crop/background/text to THIS clip, in place --
  // unlike starting a new project from a template, segments and audio mode
  // stay untouched since they're this specific edit's own. Text overlays
  // carry no timing in a template, so they span the whole clip here too.
  function applyTemplate(t: Template) {
    setTemplateStripOpen(false);
    setFreehand(false);
    setLiveCrop(null);
    setSelectedTextId(null);
    setLiveTextPos(null);
    const durationMs = duration * 1000;
    change({
      ...edit,
      canvas: t.edit.canvas,
      crop: t.edit.crop,
      textOverlays: t.edit.textOverlays.map((o) => ({
        ...o,
        startMs: 0,
        endMs: durationMs,
      })),
    });
    try {
      localStorage.setItem(LAST_TEMPLATE_KEY, t.id);
    } catch {}
  }
  function deleteTemplateInline(t: Template) {
    if (!confirm(`Delete template "${t.name}"? This cannot be undone.`))
      return;
    api(`/templates/${t.id}`, { method: "DELETE" })
      .then(() => setTemplates((cur) => cur?.filter((x) => x.id !== t.id) ?? cur))
      .catch((e: any) => onError(e.message));
  }
  function updateOverlay(id: string, changes: Partial<Overlay>) {
    change({
      ...edit,
      textOverlays: edit.textOverlays.map((t) =>
        t.id === id ? { ...t, ...changes } : t,
      ),
    });
  }
  // The starting words are a suggestion, not content: the card opens with its
  // field focused and the whole line selected, so one backspace clears it and
  // typing replaces it outright -- nobody has to hold delete down first.
  // The new card has to be rendered synchronously to be focused inside this
  // tap: a focus() in a later task is a focus without user activation, and
  // mobile browsers won't raise the keyboard for one.
  function addOverlay() {
    const id = crypto.randomUUID();
    flushSync(() => {
      change({
        ...edit,
        textOverlays: [
          ...edit.textOverlays,
          {
            id,
            text: "Make it yours.",
            font: "Inter",
            color: "#FFFFFF",
            size: 56,
            x: 0.5,
            y: 0.5,
            startMs: 0,
            endMs: duration * 1000,
          },
        ],
      });
      setSelectedTextId(id);
    });
    const field = toolBody.current?.querySelector<HTMLTextAreaElement>(
      `[data-overlay-card="${id}"] textarea`,
    );
    if (!field) return;
    // preventScroll because the panel is scrolled deliberately just below:
    // left to the browser, focus can scroll the whole workspace instead of
    // only the list the card lives in.
    field.focus({ preventScroll: true });
    field.select();
    revealOverlayCard(id);
  }
  function removeOverlay(id: string) {
    endTextInput();
    change({
      ...edit,
      textOverlays: edit.textOverlays.filter((t) => t.id !== id),
    });
    setSelectedTextId((s) => (s === id ? null : s));
  }
  // Tapping a text's on-canvas handle selects it and brings its card into
  // view in the (short, scrollable) panel, so you don't have to go hunting
  // for the right one among several.
  function selectOverlay(id: string) {
    setBlurSelected(false);
    setVideoSelected(false);
    setSelectedTextId(id);
    revealOverlayCard(id);
  }
  function revealOverlayCard(id: string) {
    requestAnimationFrame(() => {
      const panel = toolBody.current;
      const card = panel?.querySelector<HTMLElement>(`[data-overlay-card="${id}"]`);
      if (!panel || !card) return;
      const header = panel.querySelector<HTMLElement>(".sheet-header");
      const inset = (header?.getBoundingClientRect().height || 0) + 12;
      // Scroll this panel only. Align the text field's card below the sticky
      // header; "nearest" favours the card's bottom when the card is taller
      // than the panel, hiding the field the user actually wanted to edit.
      panel.scrollTo({
        top: Math.max(0, panel.scrollTop + card.getBoundingClientRect().top - panel.getBoundingClientRect().top - inset),
        behavior: "instant",
      });
    });
  }
  // The drag handle's size in canvas fractions, from the text's *actual*
  // measured footprint -- not a guess -- so grabbing it feels like grabbing
  // the rendered text rather than some arbitrary box near it. Measured on
  // the live preview canvas itself (not a fresh offscreen one) so the font
  // is guaranteed already loaded -- it's been drawing text every frame --
  // rather than risking a fallback-font measurement that doesn't match
  // what's actually on screen.
  function overlayBoxFraction(t: Overlay) {
    const [cw, ch] = dimensions(edit.canvas.aspectRatio);
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return { width: 0.3, height: 0.08 };
    const { width, height } = measureOverlay(ctx, t, cw, ch);
    return { width: width / cw, height: height / ch };
  }
  function save(snapshot = { edit, name, caption }) {
    setSaving("Saving…");
    const next = saveChain.current
      .catch(() => {})
      .then(async () => {
        const p = await api<Project>(`/projects/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify({ ...snapshot, revision: revision.current }),
        });
        revision.current = p.revision;
        committed.current = JSON.stringify(snapshot);
        if (alive.current) {
          setSaving("Saved");
          onSaved({ ...p, media });
        }
        return p;
      });
    saveChain.current = next;
    return next.catch((e) => {
      if (alive.current) {
        setSaving("Save failed");
        onError(e.message);
      }
      throw e;
    });
  }
  // Swaps which source this project edits, keeping crop/text/background/
  // segments applied to the new video. The processed audio stem (if any) is
  // specific to the OLD source's audio, so it's dropped rather than
  // silently applied to the wrong clip; segments are clamped to the new
  // duration (or replaced with one full-length segment if none would
  // survive that). onSaved's parent remounts the Editor fresh with the
  // updated project (see app/page.tsx's key), so this doesn't need to keep
  // the rest of this instance's state in sync afterward.
  function replaceMedia(newMedia: Media) {
    setReplacing(true);
    const durationMs = newMedia.duration * 1000;
    let segments = edit.segments
      .filter((s) => s.startMs < durationMs)
      .map((s) => ({ ...s, endMs: Math.min(s.endMs, durationMs) }));
    if (!segments.length)
      segments = [{ startMs: 0, endMs: durationMs, enabled: true }];
    const carriedEdit: Edit = {
      ...edit,
      segments,
      // Old timings are meaningless against a different clip's length (and
      // can fail validation outright if the new clip is shorter) -- so, like
      // applying a template, every text just spans the new clip in full.
      textOverlays: edit.textOverlays.map((t) => ({
        ...t,
        startMs: 0,
        endMs: durationMs,
      })),
      audio:
        edit.audio.mode === "original"
          ? edit.audio
          : { mode: "original", derivativeId: null },
    };
    const snapshot = { edit: carriedEdit, name, caption };
    const next = saveChain.current
      .catch(() => {})
      .then(async () => {
        const p = await api<Project>(`/projects/${initial.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...snapshot,
            revision: revision.current,
            mediaId: newMedia.id,
          }),
        });
        revision.current = p.revision;
        committed.current = JSON.stringify(snapshot);
        if (alive.current) {
          // onSaved's remount (see app/page.tsx's key) can tear this
          // instance down before it ever re-renders with carriedEdit --
          // updating latest.current eagerly, not just via the render that
          // may never come, keeps it matching committed.current so the
          // unmount-flush effect above doesn't see a false "unsaved change"
          // and refire a PATCH with this instance's now-stale pre-replace
          // edit against the new (and possibly shorter) clip's duration.
          latest.current = snapshot;
          setEdit(carriedEdit);
          onSaved(p);
        }
        return p;
      });
    saveChain.current = next;
    return next
      .catch((e) => {
        if (alive.current) onError(e.message);
        throw e;
      })
      .finally(() => {
        if (alive.current) setReplacing(false);
      });
  }
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setSaving("Unsaved");
    const timer = setTimeout(() => {
      void save().catch(() => {});
    }, 1200);
    return () => clearTimeout(timer);
  }, [edit, name, caption]); // Serialized saves prevent overlapping revision writes.
  useEffect(() => {
    let frame: number;
    let lastEdit: Edit | null = null, lastTime = -1, lastDraw = 0, lastReady = -1;
    let lastPanX: number | null = null, lastPanY: number | null = null;
    let lastBlur: BlurRegion | null = null;
    let lastZoom: number | null = null;
    const draw = () => {
      const v = video.current,
        ctx = canvas.current?.getContext("2d");
      if (v && ctx) {
        if (!v.paused) {
          const segments = current.current.segments,
            ms = v.currentTime * 1000;
          const s = segments.find(
            (s) => s.enabled && ms >= s.startMs && ms < s.endMs - 20,
          );
          if (!s) {
            const next = segments.find((s) => s.enabled && s.startMs > ms);
            if (next) {
              v.currentTime = next.startMs / 1000;
              if (derived.current) derived.current.currentTime = v.currentTime;
            } else {
              v.pause();
              derived.current?.pause();
              setPlaying(false);
            }
          }
        }
        const now = performance.now();
        const live = liveOffset.current;
        const blur = liveBlurRef.current;
        if (
          now - lastDraw >= 32 &&
          (lastEdit !== current.current ||
            lastTime !== v.currentTime ||
            lastReady !== v.readyState ||
            lastPanX !== live?.x ||
            lastPanY !== live?.y ||
            lastBlur !== blur || lastZoom !== liveZoomRef.current)
        ) {
          let drawEdit = live
            ? {
                ...current.current,
                crop: {
                  ...current.current.crop,
                  centerX: live.x,
                  centerY: live.y,
                },
              }
            : current.current;
          // Mid-drag the committed edit still holds the old rectangle, so the
          // preview has to be told about the one under the pointer or the
          // blur would only catch up once the drag ended.
          if (blur) drawEdit = { ...drawEdit, blur };
          if (liveZoomRef.current !== null) drawEdit = { ...drawEdit, crop: { ...drawEdit.crop, zoom: liveZoomRef.current } };
          preview(ctx, v, drawEdit);
          lastDraw = now;
          lastEdit = current.current;
          lastTime = v.currentTime;
          lastReady = v.readyState;
          lastPanX = live?.x ?? null;
          lastPanY = live?.y ?? null;
          lastBlur = blur;
          lastZoom = liveZoomRef.current;
        }
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, []);
  function seek(seconds: number) {
    if (!video.current) return;
    video.current.currentTime = seconds;
    if (derived.current) derived.current.currentTime = seconds;
    setTime(seconds);
  }
  async function toggle() {
    const v = video.current;
    if (!v) return;
    if (v.paused) {
      if (v.currentTime >= duration - 0.05)
        seek(edit.segments.find((s) => s.enabled)!.startMs / 1000);
      await v.play();
      if (derived.current && edit.audio.derivativeId) {
        derived.current.currentTime = v.currentTime;
        await derived.current.play();
      }
      setPlaying(true);
    } else {
      v.pause();
      derived.current?.pause();
      setPlaying(false);
    }
  }
  // Reposition the cropped rectangle by dragging directly on the composited
  // preview -- distinct from Free hand's edge handles (which resize the
  // crop) and from the Top/Bottom/Left/Right sliders (which only choose
  // how much source is kept): this only ever moves crop.offsetX/offsetY,
  // which is a completely separate concern from the crop selection itself.
  // That's deliberate -- position used to piggyback on crop.x/crop.y, which
  // meant a drag could only move as far as the crop selection's own source
  // position allowed (and fighting the Top/Left sliders, which read the
  // same fields). offsetX/offsetY instead range across the FULL canvas, so
  // this drags the video like a free object over the whole background.
  // Eases toward canvas-centered the closer a drag gets on either axis,
  // without ever hard-locking there -- the position always stays a free
  // blend of the raw pointer position and center, so it can still be
  // dragged away.
  // A tap on bare stage (or on the video that isn't a drag) means "I'm done
  // with that tool". Closing the sheet was only ever half of it: on desktop
  // there is no sheet, so the panel and its highlighted tab stayed lit with
  // no way to put them away.
  function retireTool() {
    setBlurSelected(false);
    setVideoSelected(false);
    if (sheetOpen) closeSheet();
    setTab("");
    setSelectedTextId(null);
    setLiveTextPos(null);
  }
  function panDown(e: ReactPointerEvent<HTMLDivElement>) {
    // Stops the preview stage's own pointerdown (which closes the open
    // sheet on a tap outside it) from treating the start of a legitimate
    // drag as an "outside" tap. The crop-pan frame covers the video
    // whenever the Crop tab is active (sheet open or not), which would
    // otherwise block the video's own long-press menu entirely on the
    // default tab -- so this also drives that same long-press timer;
    // panMove cancels it the moment an actual drag is detected.
    e.stopPropagation();
    e.preventDefault();
    videoPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (videoPointers.current.size > 1) {
      cancelLongPress();
      e.currentTarget.setPointerCapture(e.pointerId);
      if (panDrag.current?.allowed && videoPointers.current.size === 2) {
        const [a, b] = [...videoPointers.current.values()];
        const zoom = edit.crop.zoom ?? 1;
        pinch.current = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom, value: zoom };
      }
      return;
    }
    startLongPress(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    if (!videoRect) return;
    panDrag.current = {
      startX: e.clientX,
      startY: e.clientY,
      startOffsetX: (videoRect.drawX + videoRect.drawWidth / 2) / previewCanvasWidth,
      startOffsetY: (videoRect.drawY + videoRect.drawHeight / 2) / previewCanvasHeight,
      boxWidthPx: rect.width,
      boxHeightPx: rect.height,
      moved: false,
      allowed: videoSelected && selectedTextId === null,
    };
  }
  function easePan(raw: number) {
    const snapZone = 0.06,
      dist = Math.abs(raw - 0.5),
      pull = dist < snapZone ? (1 - dist / snapZone) ** 2 * 0.7 : 0;
    return { value: raw + (0.5 - raw) * pull, near: dist < snapZone };
  }
  function panMove(e: ReactPointerEvent<HTMLDivElement>) {
    moveLongPress(e);
    if (!videoPointers.current.has(e.pointerId)) return;
    videoPointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch.current) {
      if (videoPointers.current.size === 2) {
        const [a, b] = [...videoPointers.current.values()];
        const p = pinch.current;
        p.value = Math.min(4, Math.max(0.25, p.zoom * Math.hypot(a.x - b.x, a.y - b.y) / p.distance));
        liveZoomRef.current = p.value;
        setLiveVideoZoom(p.value);
      }
      return;
    }
    const d = panDrag.current;
    if (!d || d.boxWidthPx <= 0 || d.boxHeightPx <= 0 || !videoRect) return;
    const pixelDx = e.clientX - d.startX,
      pixelDy = e.clientY - d.startY;
    if (
      !d.moved &&
      Math.abs(pixelDx) < TAP_THRESHOLD &&
      Math.abs(pixelDy) < TAP_THRESHOLD
    )
      return;
    d.moved = true;
    if (!d.allowed) return;
    // d.boxWidthPx/boxHeightPx are the on-screen pixel size of the video's
    // own draw rect (captured in panDown), matching videoRect.drawWidth/
    // drawHeight in canvas units -- that ratio converts a screen pixel to
    // canvas units, then to a fraction of the available offset range.
    const unitsPerPxX = videoRect.drawWidth / d.boxWidthPx,
      unitsPerPxY = videoRect.drawHeight / d.boxHeightPx;
    const rawX = Math.min(1, Math.max(0, d.startOffsetX + pixelDx * unitsPerPxX / previewCanvasWidth)),
      rawY = Math.min(1, Math.max(0, d.startOffsetY + pixelDy * unitsPerPxY / previewCanvasHeight));
    const easedX = easePan(rawX), easedY = easePan(rawY);
    liveOffset.current = { x: easedX.value, y: easedY.value };
    // The X guide is a vertical line shown while X is near center (and vice
    // versa) -- each marks the axis currently aligned, like a crosshair.
    if (panGuideX.current)
      panGuideX.current.style.opacity = easedX.near ? "1" : "0";
    if (panGuideY.current)
      panGuideY.current.style.opacity = easedY.near ? "1" : "0";
  }
  function panUp(e: ReactPointerEvent<HTMLDivElement>) {
    cancelLongPress();
    videoPointers.current.delete(e.pointerId);
    if (e.type === "pointercancel") {
      videoPointers.current.clear();
      liveOffset.current = null;
      pinch.current = null;
      panDrag.current = null;
    }
    if (videoPointers.current.size) return;
    if ((panDrag.current?.moved && liveOffset.current) || pinch.current)
      change({
        ...edit,
        crop: {
          ...edit.crop,
          ...(liveOffset.current ? { centerX: liveOffset.current.x, centerY: liveOffset.current.y } : {}),
          ...(pinch.current ? { zoom: pinch.current.value } : {}),
        },
      });
    // The pan layer covers the whole video, so a tap that never became a drag
    // is the "I'm done with that tool" tap the stage underneath would have
    // handled. Only a real drag is exempt.
    else if (panDrag.current && !panDrag.current.moved) {
      setBlurSelected(false);
      setSelectedTextId(null);
      setVideoSelected(true);
    }
    if (panGuideX.current) panGuideX.current.style.opacity = "0";
    if (panGuideY.current) panGuideY.current.style.opacity = "0";
    liveOffset.current = null;
    panDrag.current = null;
    pinch.current = null;
    liveZoomRef.current = null;
    setLiveVideoZoom(null);
  }
  function split() {
    const ms = time * 1000,
      i = edit.segments.findIndex(
        (s) => ms > s.startMs + 100 && ms < s.endMs - 100,
      );
    if (i < 0) return;
    const s = edit.segments[i];
    change({
      ...edit,
      segments: [
        ...edit.segments.slice(0, i),
        { ...s, endMs: ms },
        { ...s, startMs: ms },
        ...edit.segments.slice(i + 1),
      ],
    });
    setSelected(i + 1);
  }
  async function exportVideo() {
    if (!deviceSupported) {
      onError("Device export needs HTTPS and a supported browser with WebCodecs. Update your browser; server rendering is disabled.");
      return;
    }
    setRendering(true);
    onError("");
    try {
      const snapshot = structuredClone({ edit, name, caption });
      const p = await save(snapshot);
      await onQueue({ project: { ...p, media }, quality });
      if (alive.current) setExportMenuOpen(false);
    } catch (e: any) {
      onError(e.message);
    } finally {
      if (alive.current) setRendering(false);
    }
  }
  async function separate(mode: string) {
    setSeparating(true);
    onError("");
    abort.current = new AbortController();
    try {
      const { separateAudio } = await import("@/lib/audio");
      const blob = await separateAudio(
        fileUrl("media", media.id, "audioFile"),
        mode,
        (s) => setAudioStatus(s),
        abort.current.signal,
      );
      setStem({ blob, url: URL.createObjectURL(blob), mode });
      setAudioStatus("Preview ready. Apply it to your edit.");
    } catch (e: any) {
      if (e.name !== "AbortError") onError(e.message);
      setAudioStatus("");
    } finally {
      setSeparating(false);
    }
  }
  async function applyStem() {
    if (!stem) return;
    setSeparating(true);
    try {
      const body = new FormData();
      body.append("file", stem.blob, "processed.wav");
      const { job } = await api(`/projects/${initial.id}/audio`, {
        method: "POST",
        body,
      });
      const ready = await awaitJob(job.id);
      change({
        ...edit,
        audio: { mode: stem.mode, derivativeId: ready.resultId },
      });
      setAudioStatus("Processed audio applied.");
      setStem(null);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setSeparating(false);
    }
  }
  const effective =
    edit.segments
      .filter((s) => s.enabled)
      .reduce((a, s) => a + s.endMs - s.startMs, 0) / 1000;
  return (
    <section className={`editor${fullscreenPreview ? " fullscreen-preview" : ""}`} ref={editorRoot}
      onKeyDown={(e) => { if (e.key === "Escape") setFullscreenPreview(false); }}>
      <div className="editor-heading">
        {onBack && (
          <button
            className="back-button"
            aria-label="Back to projects"
            onClick={onBack}
          >
            <ChevronLeft size={22} />
          </button>
        )}
        <div className="editor-title">
          <input
            className="project-name"
            aria-label="Project name"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
          />
          <span className="save-state">
            {saving} · {clock(effective)} edited length
          </span>
        </div>
        <div className="row">
          <button
            className="subtle save-action"
            onClick={() => save().catch(() => {})}
          >
            <Save size={16} /> <span className="label-text">Save</span>
          </button>
          <div className="split-button">
            <button
              className="primary"
              disabled={rendering}
              onClick={exportVideo}
            >
              {rendering ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Download size={17} />
              )}{" "}
              <span className="export-label-full">
                {rendering
                  ? "Queuing…"
                  : `Export ${quality} · this device`}
              </span>
              <span className="export-label-short">
                {rendering ? "…" : "Export"}
              </span>
            </button>
            <button
              className="primary split-caret"
              disabled={rendering}
              aria-label="Export options"
              aria-haspopup="menu"
              aria-expanded={exportMenuOpen}
              onClick={() => setExportMenuOpen((v) => !v)}
            >
              <ChevronDown size={16} />
            </button>
            {exportMenuOpen && (
              <div className="card-menu-list export-options" role="menu">
                <span className="export-options-label">Quality</span>
                <label className="export-option-row">
                  <input
                    type="radio"
                    name="quality"
                    checked={quality === "1080p"}
                    onChange={() => { setQuality("1080p"); setExportMenuOpen(false); }}
                  />
                  1080p
                </label>
                <label className="export-option-row">
                  <input
                    type="radio"
                    name="quality"
                    checked={quality === "720p"}
                    onChange={() => { setQuality("720p"); setExportMenuOpen(false); }}
                  />
                  720p
                </label>
                <p className="hint"><Smartphone size={15} /> This device only. Exports continue while you edit another video.</p>
                {!deviceSupported && <p role="status">Requires HTTPS and a supported WebCodecs browser.</p>}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="edit-workspace">
        <div className="preview-column">
          <div
            className="preview-stage"
            onPointerDown={(e) => {
              // A tap anywhere on the stage that isn't an interactive
              // element itself (those stop propagation before this ever
              // runs -- text handles, the crop-pan drag target) closes
              // whatever tool sheet is open. Excluded in freehand mode: a
              // tap inside the crop area that misses a handle is a normal
              // part of adjusting it there, not an "outside" tap dismissing
              // the sheet. With no sheet open, the same tap just
              // deactivates whichever text is selected.
              if (templateStripOpen) setTemplateStripOpen(false);
              if (freehand) {
                startLongPress(e);
                return;
              }
              retireTool();
              startLongPress(e);
            }}
            onPointerMove={moveLongPress}
            onPointerUp={cancelLongPress}
            onPointerCancel={cancelLongPress}
          >
            <div className="preview-screen-controls"><button className="preview-fullscreen-button" aria-label={fullscreenPreview ? "Exit fullscreen preview" : "Fullscreen preview"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                endTextInput(); exitFreehand();
                if (fullscreenPreview) {
                  setFullscreenPreview(false);
                  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
                } else {
                  setFullscreenPreview(true);
                  // Unsupported mobile browsers retain the viewport-filling preview.
                  void editorRoot.current?.requestFullscreen?.().catch(() => {});
                }
              }}>
              {fullscreenPreview ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
            </button></div>
            <canvas
              ref={canvas}
              aria-label="Edited video preview"
              style={freehand ? { display: "none" } : undefined}
            />
            <video
              ref={video}
              className={`source-video${freehand ? " source-video-visible" : ""}`}
              src={fileUrl("media", media.id)}
              muted={edit.audio.mode !== "original"}
              playsInline
              preload="auto"
              onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
              onEnded={() => {
                setPlaying(false);
                derived.current?.pause();
              }}
            />
            {edit.audio.derivativeId && (
              <audio
                ref={derived}
                src={fileUrl("audio", edit.audio.derivativeId)}
                muted={["mute", "original"].includes(edit.audio.mode)}
              />
            )}
            {freehand && (
              <CropOverlay
                crop={liveCrop ?? edit.crop}
                sourceWidth={media.width}
                sourceHeight={media.height}
                onChange={setLiveCrop}
                onCommit={() => {
                  setLiveCrop((c) => {
                    if (c) change({ ...edit, crop: c });
                    return null;
                  });
                }}
              />
            )}
            {/* Not tied to the Crop tab: dragging the video to reposition it
                is direct manipulation like moving a caption or a blur box,
                and gating it behind a tab made the video go dead the moment
                any other tool was picked (or none was). A tap that never
                becomes a drag still falls through to retiring the tool. */}
            {!freehand && videoRect && (
              <div
                className="crop-pan-outer"
                aria-hidden="true"
                style={{ aspectRatio: "9 / 16" }}
              >
                <div
                  className={`crop-pan-frame${videoSelected && selectedTextId === null ? " selected" : ""}`}
                  style={{
                    left: `${(videoRect.drawX / previewCanvasWidth) * 100}%`,
                    top: `${(videoRect.drawY / previewCanvasHeight) * 100}%`,
                    width: `${(videoRect.drawWidth / previewCanvasWidth) * 100}%`,
                    height: `${(videoRect.drawHeight / previewCanvasHeight) * 100}%`,
                  }}
                  onPointerDown={panDown}
                  onPointerMove={panMove}
                  onPointerUp={panUp}
                  onPointerCancel={panUp}
                >
                  <span className="crop-pan-guide-x" ref={panGuideX} />
                  <span className="crop-pan-guide-y" ref={panGuideY} />
                </div>
              </div>
            )}
            {/* Rendered after the crop pan frame (which covers the whole
                video on the Crop tab) so a tap lands on the thing you can
                see and mean, not on the layer above it. Both stay live
                whatever tab is open: grabbing a blur box or a caption is how
                you'd expect to move it, and having to find the matching tab
                first is a detour. Taking hold of one selects its tool. */}
            {!freehand && (liveBlur ?? edit.blur) && (
              <BlurOverlay
                region={(liveBlur ?? edit.blur)!}
                active={blurSelected && !selectedTextId && !videoSelected}
                onCancel={() => { liveBlurRef.current = null; setLiveBlur(null); }}
                onGrab={() => { setBlurSelected(true); setSelectedTextId(null); setVideoSelected(false); }}
                onDelete={() => {
                  liveBlurRef.current = null;
                  setLiveBlur(null);
                  change({ ...edit, blur: null });
                }}
                onChange={(b) => {
                  liveBlurRef.current = b;
                  setLiveBlur(b);
                }}
                onCommit={() => {
                  setLiveBlur((b) => {
                    if (b) change({ ...edit, blur: b });
                    liveBlurRef.current = null;
                    return null;
                  });
                }}
              />
            )}
            {!freehand && (
              <div
                className="text-drag-frame"
                ref={textFrame}
                aria-hidden="true"
                // Always a 9:16 box, matching the canvas's own fixed shape --
                // without this the frame had no intrinsic size at all and
                // silently stretched to the whole stage, making every drag
                // handle read as a fraction of the wrong, larger box.
                style={{ aspectRatio: "9 / 16" }}
              >
                {edit.textOverlays
                  .filter(
                    (t) =>
                      time * 1000 >= t.startMs && time * 1000 <= t.endMs,
                  )
                  .map((t) => {
                    const pos =
                      liveTextPos?.id === t.id
                        ? liveTextPos
                        : { x: t.x, y: t.y };
                    const box = overlayBoxFraction(t);
                    return (
                      <TextDragHandle
                        key={t.id}
                        x={pos.x}
                        y={pos.y}
                        width={box.width}
                        height={box.height}
                        frameRef={textFrame}
                        selected={selectedTextId === t.id}
                        onGrab={() => setTab("text")}
                        onTap={() => selectOverlay(t.id)}
                        onDelete={() => removeOverlay(t.id)}
                        onCancel={() => setLiveTextPos(null)}
                        onChange={(x, y) =>
                          setLiveTextPos({ id: t.id, x, y })
                        }
                        onCommit={() => {
                          selectOverlay(t.id);
                          setLiveTextPos((p) => {
                            if (p && p.id === t.id)
                              updateOverlay(t.id, { x: p.x, y: p.y });
                            return null;
                          });
                        }}
                      />
                    );
                  })}
              </div>
            )}
          </div>
          <div className="playback">
            <button
              aria-label={playing ? "Pause video" : "Play video"}
              className="play-button"
              onClick={() =>
                toggle().catch((e) => {
                  // A play() call the browser itself aborted because a
                  // pause() (often just a fast second tap) landed before it
                  // resolved -- expected, not an error worth alarming over.
                  if (e?.name !== "AbortError") onError(e.message);
                })
              }
            >
              {playing ? <Pause size={15} /> : <Play size={15} />}
            </button>
            <input
              aria-label="Seek"
              type="range"
              className="scrub-bar"
              min="0"
              max={duration}
              step="0.01"
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <span className="playback-time">
              {clock(time)} / {clock(duration)}
            </span>
          </div>
          <div className="timeline">
            <div className="timeline-toolbar">
              <strong>Timeline</strong>
              <div className="row">
                <button
                  aria-label="Undo"
                  disabled={!past.length}
                  onClick={() => {
                    setFuture((f) => [edit, ...f]);
                    setEdit(past.at(-1)!);
                    setPast(past.slice(0, -1));
                  }}
                >
                  <Undo2 size={17} />
                </button>
                <button
                  aria-label="Redo"
                  disabled={!future.length}
                  onClick={() => {
                    setPast((p) => [...p, edit]);
                    setEdit(future[0]);
                    setFuture(future.slice(1));
                  }}
                >
                  <Redo2 size={17} />
                </button>
                <button className="subtle compact" onClick={split}>
                  <Scissors size={15} /> Split
                </button>
                <button
                  aria-label="Remove selected clip"
                  disabled={
                    !edit.segments[selected]?.enabled ||
                    edit.segments.filter((s) => s.enabled).length < 2
                  }
                  onClick={() =>
                    change({
                      ...edit,
                      segments: edit.segments.map((s, i) =>
                        i === selected ? { ...s, enabled: false } : s,
                      ),
                    })
                  }
                >
                  <Trash2 size={17} />
                </button>
              </div>
            </div>
            <input
              aria-label="Timeline playhead"
              className="timeline-scrub"
              type="range"
              min="0"
              max={duration}
              step="0.01"
              value={time}
              onChange={(e) => seek(Number(e.target.value))}
            />
            <div className="clip-track">
              {edit.segments.map((s, i) => (
                <button
                  key={`${s.startMs}-${s.endMs}`}
                  className={`clip ${selected === i ? "selected" : ""} ${!s.enabled ? "removed" : ""}`}
                  style={{ flex: Math.max(0.1, s.endMs - s.startMs) }}
                  title={`${clock(s.startMs / 1000)}–${clock(s.endMs / 1000)}${s.enabled ? "" : " removed; double-click to restore"}`}
                  onClick={() => {
                    setSelected(i);
                    seek(s.startMs / 1000);
                  }}
                  onDoubleClick={() => {
                    if (!s.enabled)
                      change({
                        ...edit,
                        segments: edit.segments.map((seg, n) =>
                          n === i ? { ...seg, enabled: true } : seg,
                        ),
                      });
                  }}
                >
                  <FilmStrip />
                  {s.enabled ? clock((s.endMs - s.startMs) / 1000) : "Removed"}
                </button>
              ))}
            </div>
            <div className="timeline-scale">
              <span>00:00</span>
              <span>{clock(duration / 2)}</span>
              <span>{clock(duration)}</span>
            </div>
            <p className="hint">
              Split at the playhead. Select a clip to remove it; double-click a
              removed clip to restore.
            </p>
          </div>
        </div>
        <aside
          className={`inspector ${sheetOpen ? "sheet-open" : ""}${templateStripOpen ? " template-open" : ""}${tab ? "" : " tool-idle"}${freehand ? " freehand-open" : ""}`}
        >
          <div className="tool-tabs">
            {[
              ["crop", Crop, "Crop"],
              ["blur", Droplet, "Blur"],
              ["template", LayoutTemplate, "Templates"],
              ["text", Type, "Text"],
              ["background", Palette, "Colour"],
              ["audio", Music2, "Audio"],
              ["caption", Captions, "Caption"],
            ].map(([key, Icon, label]: any) =>
              key === "template" ? (
                <button
                  key={key}
                  title={label}
                  aria-label={`${label} strip`}
                  className={templateStripOpen ? "active" : ""}
                  onClick={toggleTemplateStrip}
                >
                  <Icon size={21} />
                  <span className="tool-tab-label">{label}</span>
                </button>
              ) : (
                <button
                  key={key}
                  title={label}
                  aria-label={`${label} tools`}
                  className={tab === key && !templateStripOpen ? "active" : ""}
                  onClick={() => {
                    endTextInput();
                    // On mobile the same tab acts as a toggle for its sheet,
                    // which is how CapCut/InShot behave; on desktop the panel
                    // is always visible so this only ever switches tabs.
                    setTemplateStripOpen(false);
                    if (tab === key && sheetOpen) {
                      closeSheet();
                      exitFreehand();
                      setLiveTextPos(null);
                      setSelectedTextId(null);
                    } else {
                      setTab(key);
                      setBlurSelected(key === "blur");
                      if (key === "blur") setVideoSelected(false);
                      setSheetOpen(true);
                      if (key !== "crop") exitFreehand();
                      if (key !== "text") {
                        setLiveTextPos(null);
                        setSelectedTextId(null);
                      }
                    }
                  }}
                >
                  <Icon size={21} />
                  <span className="tool-tab-label">{label}</span>
                </button>
              ),
            )}
          </div>
          <div className="tool-body" ref={toolBody} data-tool={tab}>
            <div className="sheet-header">
              <span className="sheet-grip" aria-hidden="true" />
              <button
                className="sheet-close"
                aria-label="Close panel"
                onClick={closeSheet}
              >
                <X size={20} />
              </button>
            </div>
            {tab === "crop" && !freehand && (
              <>
                <button
                  className="primary wide freehand-toggle"
                  onClick={() => setFreehand(true)}
                >
                  <Grid3x3 size={17} /> Free hand crop
                </button>
                <hr />
                {(
                  ["top", "bottom", "left", "right"] as const
                ).map((edge) => {
                  const c = edit.crop;
                  // Each edge is fully independent: it moves only that one
                  // side, holding the opposite side's position fixed --
                  // exactly the same math as dragging that edge in Free
                  // hand, just as a slider + a typed percent.
                  // current: how much is already cropped off this edge.
                  // limit: the most this edge can take before the opposite,
                  // fixed edge would be closer than MIN_CROP away.
                  const current =
                    edge === "left"
                      ? c.x
                      : edge === "right"
                        ? 1 - (c.x + c.width)
                        : edge === "top"
                          ? c.y
                          : 1 - (c.y + c.height);
                  const limit =
                    edge === "left"
                      ? c.x + c.width - MIN_CROP
                      : edge === "right"
                        ? 1 - c.x - MIN_CROP
                        : edge === "top"
                          ? c.y + c.height - MIN_CROP
                          : 1 - c.y - MIN_CROP;
                  const maxPercent = Math.round(Math.max(0, limit) * 100);
                  const percent = Math.round(current * 100);
                  const apply = (p: number) => {
                    const v = Math.min(maxPercent, Math.max(0, p)) / 100;
                    let crop = { ...c };
                    if (edge === "left") {
                      crop.width = c.x + c.width - v;
                      crop.x = v;
                    } else if (edge === "right") {
                      crop.width = 1 - v - c.x;
                    } else if (edge === "top") {
                      crop.height = c.y + c.height - v;
                      crop.y = v;
                    } else {
                      crop.height = 1 - v - c.y;
                    }
                    change({ ...edit, crop: clampCrop(crop) });
                  };
                  const label = edge[0].toUpperCase() + edge.slice(1);
                  return (
                    <label key={edge}>
                      {label}
                      <div className="crop-axis-row">
                        <Slider
                          ariaLabel={`${label} crop percent`}
                          min={0}
                          // Fixed at 100, not maxPercent: the thumb's
                          // position is value/max, so a dynamic max made
                          // this slider's thumb visibly jump whenever a
                          // DIFFERENT edge's drag changed this edge's own
                          // limit, even though this edge's own value never
                          // moved. apply() below still enforces the real
                          // limit either way.
                          max={100}
                          step={1}
                          value={percent}
                          onChange={apply}
                        />
                        <span className="crop-axis-value">
                          <input
                            type="number"
                            aria-label={`${label} crop percent`}
                            min={0}
                            max={maxPercent}
                            value={percent}
                            onChange={(e) => apply(Number(e.target.value))}
                          />
                          %
                        </span>
                      </div>
                    </label>
                  );
                })}
                <p className="hint">
                  Each side crops on its own. Free hand below does the same
                  thing by dragging directly on the video.
                </p>
              </>
            )}
            {tab === "crop" && freehand && (
              // Stripped to a single line and two buttons on purpose: the
              // sheet floats over the preview, and at its usual height it sat
              // across the bottom of the video -- exactly where the bottom
              // crop edge is, so that edge could not be dragged at all.
              <div className="freehand-bar">
                <h2>Drag any edge</h2>
                <div className="freehand-actions">
                  <button
                    className="subtle"
                    aria-label="Reset crop"
                    title="Reset crop"
                    onClick={() =>
                      change({
                        ...edit,
                        crop: { x: 0, y: 0, width: 1, height: 1 },
                      })
                    }
                  >
                    <RotateCcw size={15} />
                  </button>
                  <button className="primary" onClick={exitFreehand}>
                    <Check size={16} /> Done
                  </button>
                </div>
              </div>
            )}
            {tab === "blur" && (
              <>
                <h2>Blur</h2>
                {edit.blur ? (
                  <>
                    <p className="hint">
                      Drag the box on the video to move it, or its corners to
                      resize.
                    </p>
                    <label>
                      Intensity <span>{edit.blur.intensity}</span>
                      <input
                        type="range"
                        min={1}
                        max={100}
                        value={edit.blur.intensity}
                        onChange={(e) =>
                          change({
                            ...edit,
                            blur: {
                              ...edit.blur!,
                              intensity: Number(e.target.value),
                            },
                          })
                        }
                      />
                    </label>
                    <button
                      className="subtle wide"
                      onClick={() => {
                        liveBlurRef.current = null;
                        setLiveBlur(null);
                        change({ ...edit, blur: null });
                      }}
                    >
                      <Trash2 size={15} /> Remove blur
                    </button>
                  </>
                ) : (
                  <>
                    <p className="hint">
                      Hide a face, a logo or a handle behind a blurred box.
                    </p>
                    <button
                      className="primary wide"
                      onClick={() => {
                        setBlurSelected(true); setVideoSelected(false); setSelectedTextId(null);
                        change({
                          ...edit,
                          blur: {
                            x: 0.3,
                            y: 0.4,
                            width: 0.4,
                            height: 0.2,
                            intensity: 50,
                          },
                        });
                      }}
                    >
                      <Droplet size={15} /> Add blur box
                    </button>
                  </>
                )}
              </>
            )}
            {tab === "background" && (
              <>
                <h2>Background</h2>
                <label>
                  Style
                  <select
                    value={edit.canvas.background.type}
                    onChange={(e) =>
                      change({
                        ...edit,
                        canvas: {
                          ...edit.canvas,
                          background: {
                            ...edit.canvas.background,
                            type: e.target.value,
                          },
                        },
                      })
                    }
                  >
                    <option value="solid">Solid color</option>
                    <option value="gradient">Gradient mix</option>
                  </select>
                </label>
                <label>Quick colors</label>
                <div className="swatches">
                  {bgColors.map((c) => (
                    <button
                      key={c}
                      style={{ background: c }}
                      aria-label={`Background ${c}`}
                      className={
                        edit.canvas.background.colors[0] === c ? "selected" : ""
                      }
                      onClick={() =>
                        change({
                          ...edit,
                          canvas: {
                            ...edit.canvas,
                            background: {
                              ...edit.canvas.background,
                              colors: [
                                c,
                                ...edit.canvas.background.colors.slice(1),
                              ],
                            },
                          },
                        })
                      }
                    />
                  ))}
                </div>
                {(edit.canvas.background.type === "gradient"
                  ? edit.canvas.background.colors
                  : edit.canvas.background.colors.slice(0, 1)
                ).map((c, i) => (
                      <CustomColor key={i}
                        label={`Custom color${edit.canvas.background.type === "gradient" ? ` ${i + 1}` : ""}`}
                        value={c}
                        onChange={(color) =>
                          change({
                            ...edit,
                            canvas: {
                              ...edit.canvas,
                              background: {
                                ...edit.canvas.background,
                                colors: edit.canvas.background.colors.map(
                                  (x, j) => (i === j ? color : x),
                                ),
                              },
                            },
                          })
                        }
                      />
                ))}
                {edit.canvas.background.type === "gradient" && (
                  <>
                    <label>
                      Angle · {edit.canvas.background.angle}°
                      <Slider
                        ariaLabel="Gradient angle"
                        min={0}
                        max={360}
                        value={edit.canvas.background.angle}
                        onChange={(angle) =>
                          change({
                            ...edit,
                            canvas: {
                              ...edit.canvas,
                              background: { ...edit.canvas.background, angle },
                            },
                          })
                        }
                      />
                    </label>
                    <button
                      className="subtle"
                      onClick={() =>
                        change({
                          ...edit,
                          canvas: {
                            ...edit.canvas,
                            background: {
                              ...edit.canvas.background,
                              colors:
                                edit.canvas.background.colors.length === 2
                                  ? [
                                      ...edit.canvas.background.colors,
                                      "#38BDF8",
                                    ]
                                  : edit.canvas.background.colors.slice(0, 2),
                            },
                          },
                        })
                      }
                    >
                      {edit.canvas.background.colors.length === 2
                        ? "Add third color"
                        : "Remove third color"}
                    </button>
                  </>
                )}
              </>
            )}
            {tab === "text" && (
              <>
                <h2>Text overlays</h2>
                <button
                  className="subtle wide"
                  disabled={edit.textOverlays.length >= 12}
                  onClick={addOverlay}
                >
                  <Plus size={16} /> Add text
                </button>
                {edit.textOverlays.map((t) => (
                  <div
                    className={`text-card${selectedTextId === t.id ? " selected" : ""}`}
                    key={t.id}
                    data-overlay-card={t.id}
                    onFocusCapture={() => { setVideoSelected(false); setSelectedTextId(t.id); }}
                  >
                    <label>
                      Text
                      <textarea
                        rows={2}
                        maxLength={500}
                        value={t.text}
                        onChange={(e) =>
                          updateOverlay(t.id, { text: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      Font
                      <select
                        value={t.font}
                        onChange={(e) =>
                          updateOverlay(t.id, { font: e.target.value })
                        }
                      >
                        {fonts.map((f) => (
                          <option key={f}>{f}</option>
                        ))}
                      </select>
                    </label>
                    <div className="swatches">
                      {textColors.map((c) => (
                        <button
                          key={c}
                          style={{ background: c }}
                          className={t.color === c ? "selected" : ""}
                          aria-label={`Text ${c}`}
                          onClick={() => updateOverlay(t.id, { color: c })}
                        />
                      ))}
                    </div>
                    {[
                      ["size", "Size", 16, 120],
                      ["x", "Horizontal", 0, 1],
                      ["y", "Vertical", 0, 1],
                    ].map(([key, label, min, max]) => (
                      <label key={key} className="text-slider-row">
                        <span>{label}</span>
                        <Slider
                          ariaLabel={`${label} for this text`}
                          min={Number(min)}
                          max={Number(max)}
                          step={key === "size" ? 1 : 0.01}
                          value={t[key as "size" | "x" | "y"]}
                          onChange={(v) => updateOverlay(t.id, { [key]: v })}
                        />
                      </label>
                    ))}
                    <div className="row">
                      <label>
                        From (sec)
                        <input
                          type="number"
                          min="0"
                          max={t.endMs / 1000 - 0.1}
                          step="0.1"
                          value={t.startMs / 1000}
                          onChange={(e) =>
                            updateOverlay(t.id, {
                              startMs: Number(e.target.value) * 1000,
                            })
                          }
                        />
                      </label>
                      <label>
                        To (sec)
                        <input
                          type="number"
                          min={t.startMs / 1000 + 0.1}
                          max={duration}
                          step="0.1"
                          value={t.endMs / 1000}
                          onChange={(e) =>
                            updateOverlay(t.id, {
                              endMs: Number(e.target.value) * 1000,
                            })
                          }
                        />
                      </label>
                    </div>
                    <button
                      className="subtle"
                      onClick={() => removeOverlay(t.id)}
                    >
                      <Trash2 size={14} /> Remove text
                    </button>
                  </div>
                ))}
              </>
            )}
            {tab === "caption" && (
              <>
                <h2>Post caption</h2>
                <p className="hint">
                  Saved separately with your edited video, ready to copy into
                  Instagram.
                </p>
                {/* Above the field, not below it: copying is what you come
                    back to this tab for once the caption is written, and a
                    long caption pushed the button off the bottom of the
                    sheet. */}
                <button
                  className="subtle wide"
                  disabled={!caption.trim()}
                  onClick={() =>
                    navigator.clipboard
                      .writeText(caption)
                      .catch((e) => onError(e.message))
                  }
                >
                  <Copy size={16} /> Copy caption
                </button>
                <textarea
                  aria-label="Post caption"
                  rows={12}
                  value={caption}
                  maxLength={8000}
                  onChange={(e) => setCaption(e.target.value)}
                />
                <span className="hint">{caption.length} characters</span>
                <div className="planned">
                  <strong>AI caption assistant</strong>
                  <p>
                    Chat / Rewrite and Analyze video are planned for a later
                    phase.
                  </p>
                </div>
              </>
            )}
            {tab === "audio" && (
              <>
                <h2>Audio</h2>
                <p className="hint">
                  Kim Vocal 2 separates vocals on your device.
                </p>
                <label>
                  Current track
                  <select
                    value={edit.audio.mode}
                    onChange={(e) =>
                      change({
                        ...edit,
                        audio: { ...edit.audio, mode: e.target.value },
                      })
                    }
                  >
                    <option value="original">Original audio</option>
                    <option value="mute">Mute audio</option>
                    {edit.audio.derivativeId && (
                      <option
                        value={
                          edit.audio.mode === "vocals-only"
                            ? "vocals-only"
                            : "remove-vocals"
                        }
                      >
                        Processed audio
                      </option>
                    )}
                  </select>
                </label>
                <hr />
                <button
                  className="subtle wide"
                  disabled={separating}
                  onClick={() => separate("remove-vocals")}
                >
                  <Music2 size={17} /> Remove vocals
                </button>
                <button
                  className="subtle wide"
                  disabled={separating}
                  onClick={() => separate("vocals-only")}
                >
                  Keep vocals only
                </button>
                {audioStatus && (
                  <p role="status" className="hint">
                    {audioStatus}
                  </p>
                )}
                {separating && (
                  <button
                    className="subtle"
                    onClick={() => abort.current?.abort()}
                  >
                    Cancel separation
                  </button>
                )}
                {stem && (
                  <div className="stem-preview">
                    <audio controls src={stem.url} />
                    <button
                      className="primary wide"
                      disabled={separating}
                      onClick={applyStem}
                    >
                      Apply processed audio
                    </button>
                  </div>
                )}
                <p className="hint">
                  Result may vary. The model downloads once (about 67 MB). CPU
                  processing can take a while.
                </p>
              </>
            )}
          </div>
        </aside>
      </div>
      {exportMenuOpen && (
        <div
          className="menu-overlay"
          onClick={() => setExportMenuOpen(false)}
        />
      )}
      {templateStripOpen && (
        <>
          <div
            className="menu-overlay"
            onClick={() => setTemplateStripOpen(false)}
          />
          <div
            className="template-strip"
            role="dialog"
            aria-label="Templates"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="template-strip-item">
              <button
                className="template-strip-add"
                aria-label="Save current look as a template"
                title="Save current look as a template"
                onClick={saveAsTemplate}
              >
                <Plus size={18} />
              </button>
              <span className="template-strip-name">Save new</span>
            </div>
            {templates === null ? (
              <LoaderCircle className="spin" size={18} />
            ) : templates.length === 0 ? (
              <span className="template-strip-hint">No templates yet</span>
            ) : (
              templates.map((t) => (
                <div className="template-strip-item" key={t.id}>
                  <button
                    className="template-strip-swatch"
                    title={t.name}
                    aria-label={`Apply template ${t.name}`}
                    style={{
                      background:
                        t.edit.canvas.background.colors[0] ?? "#111827",
                    }}
                    onClick={() => applyTemplate(t)}
                  />
                  <button
                    className="template-strip-remove"
                    aria-label={`Delete template ${t.name}`}
                    onClick={() => deleteTemplateInline(t)}
                  >
                    <Minus size={8} />
                  </button>
                  <span className="template-strip-name">{t.name}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
      {videoMenuOpen && (
        <div
          className="modal-backdrop"
          onClick={() => setVideoMenuOpen(false)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Video options"
            className="modal video-menu"
            onClick={(e) => e.stopPropagation()}
          >
            <button className="wide subtle" onClick={openMediaPicker}>
              <RefreshCw size={16} /> Replace video from Media
            </button>
            <button className="wide subtle" onClick={saveAsTemplate}>
              <Save size={16} /> Save as template
            </button>
            <button
              className="wide subtle danger"
              onClick={() => {
                setVideoMenuOpen(false);
                onDelete?.();
              }}
            >
              <Trash2 size={16} /> Delete this edit
            </button>
          </section>
        </div>
      )}
      {mediaPicker && (
        <div
          className="modal-backdrop"
          onClick={() => !replacing && setMediaPicker(null)}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Replace video"
            className="modal media-picker"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Replace with</h2>
            <p className="hint">
              Crop, text, background and cuts carry over. Applied audio
              resets to original -- it was processed from the clip you're
              replacing.
            </p>
            {mediaPicker.length === 0 ? (
              <p className="empty">No other ready clips in Media yet.</p>
            ) : (
              <div className="media-picker-grid">
                {mediaPicker.map((m) => (
                  <button
                    key={m.id}
                    className="media-picker-item"
                    disabled={replacing}
                    onClick={async () => {
                      try {
                        await replaceMedia(m);
                        setMediaPicker(null);
                      } catch {
                        // onError already surfaced it; keep the picker open.
                      }
                    }}
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
            {replacing && (
              <p className="hint">
                <LoaderCircle size={14} className="spin" /> Replacing…
              </p>
            )}
            <button
              className="wide subtle"
              disabled={replacing}
              onClick={() => setMediaPicker(null)}
            >
              Cancel
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
function FilmStrip() {
  return (
    <span className="film-strip" aria-hidden="true">
      ▥
    </span>
  );
}
type DragHandle = "t" | "b" | "l" | "r" | "tl" | "tr" | "bl" | "br";
// Freehand crop: a border with edge and corner handles laid directly over the
// full source frame. Dragging updates a live value on every pointermove but
// only commits one undo step, on release -- otherwise a single drag gesture
// would flood the undo stack with hundreds of intermediate crops.
function CropOverlay({
  crop,
  sourceWidth,
  sourceHeight,
  onChange,
  onCommit,
}: {
  crop: CropRect;
  sourceWidth: number;
  sourceHeight: number;
  onChange: (crop: CropRect) => void;
  onCommit: () => void;
}) {
  // This wrapper is given the source's own aspect ratio and the same
  // max-width/max-height as the visible <video>, so it always lands exactly
  // on the letterboxed video content -- no manual object-fit math needed.
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{
    handle: DragHandle;
    startX: number;
    startY: number;
    start: CropRect;
    width: number;
    height: number;
  } | null>(null);
  function down(handle: DragHandle) {
    return (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = box.current?.getBoundingClientRect();
      if (!rect) return;
      drag.current = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        start: crop,
        width: rect.width,
        height: rect.height,
      };
    };
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / d.width,
      dy = (e.clientY - d.startY) / d.height;
    let { x, y, width, height } = d.start;
    if (d.handle.includes("l")) {
      x += dx;
      width -= dx;
    }
    if (d.handle.includes("r")) width += dx;
    if (d.handle.includes("t")) {
      y += dy;
      height -= dy;
    }
    if (d.handle.includes("b")) height += dy;
    onChange(clampCrop({ ...d.start, x, y, width, height }));
  }
  function up() {
    if (drag.current) onCommit();
    drag.current = null;
  }
  const handles: DragHandle[] = ["t", "b", "l", "r", "tl", "tr", "bl", "br"];
  return (
    <div
      className="crop-overlay"
      ref={box}
      aria-hidden="true"
      style={
        sourceWidth && sourceHeight
          ? { aspectRatio: `${sourceWidth} / ${sourceHeight}` }
          : undefined
      }
    >
      <div
        className="crop-frame"
        style={{
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.width * 100}%`,
          height: `${crop.height * 100}%`,
        }}
      >
        <span className="crop-grid-line v" style={{ left: "33.333%" }} />
        <span className="crop-grid-line v" style={{ left: "66.666%" }} />
        <span className="crop-grid-line h" style={{ top: "33.333%" }} />
        <span className="crop-grid-line h" style={{ top: "66.666%" }} />
        {handles.map((h) => (
          <span
            key={h}
            className={`crop-handle crop-handle-${h}`}
            onPointerDown={down(h)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        ))}
      </div>
    </div>
  );
}
// A corner handle's on-screen width (.blur-handle in globals.css). Two of
// them side by side is the point below which they'd start covering each other
// and the box has to be laid out differently.
const HANDLE_PX = 22;
// The blur rectangle, dragged and resized directly on the preview. Unlike
// CropOverlay this sits on the 9:16 canvas box rather than the video's own
// letterboxed rect, because the region is stored in canvas fractions.
function BlurOverlay({
  region,
  active,
  onCancel,
  onGrab,
  onDelete,
  onChange,
  onCommit,
}: {
  region: BlurRegion;
  active: boolean;
  onCancel: () => void;
  onGrab: () => void;
  onDelete: () => void;
  onChange: (region: BlurRegion) => void;
  onCommit: () => void;
}) {
  const [snapped, setSnapped] = useState({ x: false, y: false });
  const box = useRef<HTMLDivElement>(null);
  // How wide the box actually is on screen, so a band too thin to hold its
  // own handles can be told apart from a normal box and styled for it. The
  // letterbox is measured rather than assumed: it changes with the window,
  // the sheet opening and the phone rotating.
  const [letterboxWidth, setLetterboxWidth] = useState(0);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setLetterboxWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const narrow =
    letterboxWidth > 0 && region.width * letterboxWidth < 2 * HANDLE_PX;
  const drag = useRef<{
    handle: DragHandle | "move";
    startX: number;
    startY: number;
    start: BlurRegion;
    width: number;
    height: number;
    allowed: boolean;
    moved: boolean;
    pointerId: number;
  } | null>(null);
  function down(handle: DragHandle | "move") {
    return (e: ReactPointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (drag.current) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = box.current?.getBoundingClientRect();
      if (!rect) return;
      drag.current = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        start: region,
        width: rect.width,
        height: rect.height,
        allowed: active,
        moved: false,
        pointerId: e.pointerId,
      };
    };
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId || d.width <= 0 || d.height <= 0) return;
    if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < TAP_THRESHOLD && !d.moved) return;
    d.moved = true;
    if (!d.allowed) return;
    const dx = (e.clientX - d.startX) / d.width,
      dy = (e.clientY - d.startY) / d.height;
    let { x, y, width, height } = d.start;
    if (d.handle === "move") {
      // Moving only ever translates: the box keeps its size and stops at the
      // frame edges rather than being squashed against them. Its own centre
      // is what snaps, not its corner, so "centred" means what it looks like.
      const rawX = Math.min(1 - width, Math.max(0, x + dx)),
        rawY = Math.min(1 - height, Math.max(0, y + dy));
      x = snapToCentre(rawX + width / 2) - width / 2;
      y = snapToCentre(rawY + height / 2) - height / 2;
      setSnapped({ x: x !== rawX, y: y !== rawY });
    } else {
      // Each axis is clamped against the edge being dragged, so running out
      // of room stops that edge instead of sliding the whole box: dragging
      // the right edge into the frame edge must not drag the left one along
      // with it.
      if (d.handle.includes("l")) {
        const right = d.start.x + d.start.width;
        x = Math.min(right - MIN_BLUR_WIDTH, Math.max(0, x + dx));
        width = right - x;
      } else if (d.handle.includes("r"))
        width = Math.min(1 - x, Math.max(MIN_BLUR_WIDTH, width + dx));
      if (d.handle.includes("t")) {
        const bottom = d.start.y + d.start.height;
        y = Math.min(bottom - MIN_BLUR, Math.max(0, y + dy));
        height = bottom - y;
      } else if (d.handle.includes("b"))
        height = Math.min(1 - y, Math.max(MIN_BLUR, height + dy));
    }
    onChange({ ...d.start, x, y, width, height });
  }
  function up(e: ReactPointerEvent) {
    if (drag.current?.pointerId !== e.pointerId) return;
    if (e.type === "pointercancel") onCancel();
    else if (drag.current.allowed && drag.current.moved) onCommit();
    else if (!drag.current.moved) onGrab();
    drag.current = null;
    setSnapped({ x: false, y: false });
  }
  const handles: DragHandle[] = ["tl", "tr", "bl", "br"];
  return (
    <div
      className="blur-overlay"
      ref={box}
      aria-hidden="true"
      style={{ aspectRatio: "9 / 16" }}
    >
      {drag.current && (
        <>
          <span className={`centre-guide v${snapped.x ? " snapped" : ""}`} />
          <span className={`centre-guide h${snapped.y ? " snapped" : ""}`} />
        </>
      )}
      <div
        className={`blur-frame${active ? "" : " dormant"}${narrow ? " narrow" : ""}`}
        style={{
          left: `${region.x * 100}%`,
          top: `${region.y * 100}%`,
          width: `${region.width * 100}%`,
          height: `${region.height * 100}%`,
        }}
        onPointerDown={down("move")}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {active && (
          <button
            className="overlay-delete blur-delete"
            aria-label="Remove blur"
            title="Remove blur"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <X size={14} />
          </button>
        )}
        {active && handles.map((h) => (
          <span
            key={h}
            className={`blur-handle blur-handle-${h}`}
            onPointerDown={down(h)}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        ))}
      </div>
    </div>
  );
}
// A text overlay's position, draggable directly on the preview. Position
// only, on purpose -- x/y move together as one drag, nothing else changes
// (no resize, no rotate) so a drag can never do more than reposition it. A
// tap that never moves past the threshold selects the text (so its card
// scrolls into view in the panel) instead of "dragging" it by zero.
const TAP_THRESHOLD = 4;
// SAFE_ZONE is defined in lib/canvas.ts alongside the wrap that respects the
// same edges. One number on purpose: if the clamp and the width text wraps at
// disagreed, a line would wrap at a boundary it could then be dragged past.
// How close to the centre line a drag has to get before it sticks. Kept
// small on purpose: enough that centring something is effortless, not so
// much that deliberately placing text just off-centre becomes a fight.
const SNAP = 0.018;
function snapToCentre(value: number) {
  return Math.abs(value - 0.5) < SNAP ? 0.5 : value;
}
function TextDragHandle({
  x,
  y,
  width,
  height,
  frameRef,
  selected,
  onGrab,
  onTap,
  onDelete,
  onCancel,
  onChange,
  onCommit,
}: {
  x: number;
  y: number;
  width: number;
  height: number;
  frameRef: RefObject<HTMLDivElement | null>;
  selected: boolean;
  onGrab: () => void;
  onTap: () => void;
  onDelete: () => void;
  onCancel: () => void;
  onChange: (x: number, y: number) => void;
  onCommit: () => void;
}) {
  const drag = useRef<{
    startX: number;
    startY: number;
    startVX: number;
    startVY: number;
    boxWidth: number;
    boxHeight: number;
    moved: boolean;
    allowed: boolean;
    pointerId: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [snapped, setSnapped] = useState({ x: false, y: false });
  function down(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current) { e.stopPropagation(); return; }
    onGrab();
    e.preventDefault();
    // Stops the preview stage's own pointerdown (which deselects whatever
    // text is active on any tap outside it) from firing right behind this
    // one and immediately undoing the selection a tap here just made.
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    drag.current = {
      startX: e.clientX,
      startY: e.clientY,
      startVX: x,
      startVY: y,
      boxWidth: rect.width,
      boxHeight: rect.height,
      moved: false,
      allowed: selected,
      pointerId: e.pointerId,
    };
    setDragging(selected);
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId || d.boxWidth <= 0 || d.boxHeight <= 0) return;
    const pixelDx = e.clientX - d.startX,
      pixelDy = e.clientY - d.startY;
    if (
      !d.moved &&
      Math.abs(pixelDx) < TAP_THRESHOLD &&
      Math.abs(pixelDy) < TAP_THRESHOLD
    )
      return;
    d.moved = true;
    if (!d.allowed) return;
    // Capped at 0.9 rather than 1 -- dragging text flush to the video's
    // right/bottom edge crops it against safe-zone overlays (captions, UI
    // chrome) on most platforms it gets reposted to. Top and left get their
    // own floors, each offset by half the box so its rendered footprint stays
    // out of the band, not merely its centre point.
    const minY = SAFE_ZONE.top + height / 2,
      minX = SAFE_ZONE.left + width / 2,
      maxX = 1 - SAFE_ZONE.right - width / 2;
    const rawX = Math.min(
        Math.max(minX, maxX),
        Math.max(minX, d.startVX + pixelDx / d.boxWidth),
      ),
      rawY = Math.min(0.9, Math.max(minY, d.startVY + pixelDy / d.boxHeight));
    const x = snapToCentre(rawX),
      y = snapToCentre(rawY);
    setSnapped({ x: x !== rawX, y: y !== rawY });
    onChange(x, y);
  }
  function up(e: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.pointerId !== e.pointerId) return;
    if (e.type === "pointercancel") onCancel();
    else if (drag.current?.moved && drag.current.allowed) onCommit();
    else if (drag.current && !drag.current.moved) onTap();
    drag.current = null;
    setDragging(false);
    setSnapped({ x: false, y: false });
  }
  return (
    <>
      {dragging && (
        <>
          <div className="text-safe-zone top" aria-hidden="true">
            <span>Stays clear of platform UI</span>
          </div>
          <div className="text-safe-zone left" aria-hidden="true" />
          <div className="text-safe-zone right" aria-hidden="true" />
          <span
            className={`centre-guide v${snapped.x ? " snapped" : ""}`}
            aria-hidden="true"
          />
          <span
            className={`centre-guide h${snapped.y ? " snapped" : ""}`}
            aria-hidden="true"
          />
        </>
      )}
      <div
        className={`text-drag-handle${selected ? " selected" : ""}`}
        style={{
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          width: `${width * 100}%`,
          height: `${height * 100}%`,
        }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      >
        {selected && (
          <button
            className="overlay-delete text-drag-delete"
            aria-label="Delete this text"
            title="Delete this text"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <X size={14} />
          </button>
        )}
      </div>
    </>
  );
}
