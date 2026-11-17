/*
 * The JPEG quality page: which ASSET_QUALITY and THUMB_QUALITY, measured in
 * each phone's own browser. Dev only. It is built and served on its own
 * (`pnpm --filter @vitrina/web jpeg-quality`), and check-build.mjs fails a
 * production build that contains it.
 *
 * Every encode goes through prepare.ts's own decode() and jpeg(), with the
 * app's browserImaging: the frame-size read, the resized decode, orientation,
 * the 1600 and 480 px fits, the canvas, toBlob, and the segment filter. The
 * sizes are therefore the bytes the app would encrypt.
 *
 * The comparison draws with render.ts's drawViewer and drawCell, at the
 * viewer's stage size and the grid's cell size, and moves with the viewer's
 * own Gestures, so a crop at maximum zoom is the crop a recipient gets.
 *
 * Nothing leaves the page and nothing is kept: no request (the CSP in
 * index.html refuses every one), no storage, no object URL. Photos go from the
 * file input to a bitmap and back to bytes in memory. The measuring pass keeps
 * numbers only; the photo being compared is encoded again, and its bitmaps are
 * closed when another photo is opened.
 */
import { browserImaging } from "../../src/lib/owner/imaging";
import { jpegFrameSize } from "../../src/lib/owner/jpeg-scan";
import { ASSET_LONG_EDGE, ASSET_QUALITY, CHUNK_SIZE, HEAD_BYTES, THUMB_LONG_EDGE, THUMB_QUALITY, decode, fitLongEdge, jpeg, type Dims, type Resize } from "../../src/lib/owner/prepare";
import { Gestures } from "../../src/lib/recipient/gestures";
import { DOUBLE_TAP_SCALE, FIT, MAX_SCALE, clampView, drawCell, drawViewer, moveView, type Size, type View } from "../../src/lib/recipient/render";
import { ASSET_QUALITIES, THUMB_QUALITIES, browserLabel, describeError, gridCell, report, shuffled, summarise, viewerStage, type Kind, type Row } from "./bench";

/**
 * check-build.mjs fails a production build that contains this string. It is
 * written into the page below, so a bundle that imports this module keeps it.
 */
const BENCH_MARKER = "vitrina:jpeg-quality-bench";

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} is missing`);
  return el as T;
}

const ui = {
  device: $("device"),
  files: $<HTMLInputElement>("files"),
  status: $("status"),
  compare: $("compare"),
  prev: $<HTMLButtonElement>("prev"),
  next: $<HTMLButtonElement>("next"),
  which: $("which"),
  frame: $<HTMLSelectElement>("frame"),
  blind: $<HTMLInputElement>("blind"),
  reveal: $<HTMLButtonElement>("reveal"),
  stageNote: $("stage-note"),
  photoError: $("photo-error"),
  stage: $("stage"),
  photo: $<HTMLCanvasElement>("photo"),
  fit: $<HTMLButtonElement>("fit"),
  z2: $<HTMLButtonElement>("z2"),
  zmax: $<HTMLButtonElement>("zmax"),
  assetQ: $("asset-q"),
  assetNow: $("asset-now"),
  cell: $<HTMLCanvasElement>("cell"),
  thumbQ: $("thumb-q"),
  thumbNow: $("thumb-now"),
  determinism: $("determinism"),
  numbers: $("numbers"),
  sumAsset: $<HTMLTableElement>("sum-asset"),
  sumThumb: $<HTMLTableElement>("sum-thumb"),
  perPhoto: $<HTMLTableElement>("per-photo"),
  csv: $<HTMLTextAreaElement>("csv"),
  copy: $<HTMLButtonElement>("copy"),
  copied: $("copied"),
};

document.documentElement.dataset["page"] = BENCH_MARKER;

const browser = browserLabel(navigator.userAgent, navigator.maxTouchPoints);
const dpr = (): number => window.devicePixelRatio || 1;
/** Chrome's rounded RAM figure (navigator.deviceMemory); Safari and Firefox give none. */
const deviceMemory = (): string => {
  const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof gb === "number" ? `${gb} GB` : "not reported";
};
const kB = (b: number): string => (Number.isFinite(b) ? (b / 1000).toFixed(1) : "–");
const ms = (t: number): string => (Number.isFinite(t) ? t.toFixed(0) : "–");

// ── Encoding: prepare.ts's path, at every quality ──────────────────────────

type Encode = { readonly kind: Kind; readonly quality: number; readonly bytes: Uint8Array<ArrayBuffer>; readonly ms: number };
type Encoded = { readonly size: Dims; readonly decodeMs: number; readonly encodes: Encode[] };

/** The encoder's first use pays its own start-up; one untimed encode per session keeps that out of 0.70's time. */
let warmed = false;

const zero = (encodes: readonly Encode[]): void => encodes.forEach((e) => e.bytes.fill(0));

/** One photo: decoded once, as prepare() does, then encoded at each quality. A string is what failed. */
async function encodePhoto(file: File): Promise<Encoded | string> {
  const t0 = performance.now();
  let bitmap;
  try {
    bitmap = await decode(file, browserImaging);
  } catch (e) {
    return `not-decoded: the browser refused it (${describeError(e, file.name)})`;
  }
  if (bitmap === null) return "not-decoded: it opened, but not at the size its header gives";
  const decodeMs = performance.now() - t0;
  const encodes: Encode[] = [];
  try {
    // As prepare(): the asset fitted to 1600 px, the thumbnail fitted from that, both drawn from this bitmap.
    const size = fitLongEdge(bitmap, ASSET_LONG_EDGE);
    const thumbSize = fitLongEdge(size, THUMB_LONG_EDGE);
    if (!warmed) {
      const w = await jpeg(browserImaging, bitmap, thumbSize, THUMB_QUALITY);
      if (w.ok) w.bytes.fill(0);
      warmed = true;
    }
    const plan: [Kind, number, Dims][] = [
      ...ASSET_QUALITIES.map((q): [Kind, number, Dims] => ["asset", q, size]),
      ...THUMB_QUALITIES.map((q): [Kind, number, Dims] => ["thumb", q, thumbSize]),
    ];
    for (const [kind, quality, at] of plan) {
      const t = performance.now();
      const r = await jpeg(browserImaging, bitmap, at, quality);
      const took = performance.now() - t;
      if (!r.ok) {
        zero(encodes);
        return `${kind} at ${quality.toFixed(2)}: ${r.error}`;
      }
      encodes.push({ kind, quality, bytes: r.bytes, ms: took });
    }
    return { size, decodeMs, encodes };
  } finally {
    bitmap.close();
  }
}

/**
 * Why a photo failed, in numbers: its type and size, the frame size its
 * header gives, and what the browser answered to each decode prepare.ts
 * would ask for. Runs only after a failure; never part of a measurement.
 */
async function diagnose(file: File): Promise<string> {
  const parts = [
    `picked ${Math.round((performance.now() - pickedAt) / 1000)} s ago`,
    `phone memory ${deviceMemory()}`,
    `type ${file.type || "(none given)"}`,
    `${(file.size / 1e6).toFixed(1)} MB`,
  ];
  let frame: Dims | null = null;
  try {
    const head = new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer());
    parts.push("reading the file → ok");
    frame = jpegFrameSize(head);
    parts.push(frame === null ? "no JPEG frame in its first 256 KiB" : `frame ${frame.width}×${frame.height}`);
  } catch (e) {
    parts.push(`reading the file → ${describeError(e, file.name)}`);
  }
  const attempt = async (label: string, resize: Resize | null): Promise<string> => {
    try {
      const b = await browserImaging.decode(file, resize);
      const got = `${label} → ${b.width}×${b.height}`;
      b.close();
      return got;
    } catch (e) {
      return `${label} → ${describeError(e, file.name)}`;
    }
  };
  if (frame !== null && Math.max(frame.width, frame.height) > ASSET_LONG_EDGE) {
    parts.push(await attempt("decode at width 1600", { width: ASSET_LONG_EDGE }));
    parts.push(await attempt("decode at height 1600", { height: ASSET_LONG_EDGE }));
  }
  parts.push(await attempt("full decode", null));
  return parts.join("; ");
}

// ── Measuring pass: numbers only ───────────────────────────────────────────

let files: File[] = [];
/** When the photos were picked: a photo that reads at first and not later is a different failure from one that never reads. */
let pickedAt = 0;
/** Failures on opening a photo again to compare, after it measured. */
const later: string[] = [];
/** How the copy at pick went, for the copied numbers. */
let copyNote = "";
let rows: Row[] = [];
const failures = new Map<number, string>();
const decodeTimes = new Map<number, number>();
let busy = false;

async function measure(list: File[]): Promise<void> {
  busy = true;
  closeShown();
  ui.compare.hidden = true;
  ui.numbers.hidden = true;
  pickedAt = performance.now();
  later.length = 0;
  rows = [];
  failures.clear();
  decodeTimes.clear();
  // Every photo copied into memory first, before any decoding. On an Android phone short
  // of memory, the app the photos were picked from can be closed as soon as the work
  // begins, and with it the browser's right to read them: photo 1 read, the rest
  // NotReadableError within seconds. The copy keeps the bytes and the type, not the name.
  files = [];
  const unread = new Map<number, string>();
  for (let i = 0; i < list.length; i++) {
    ui.status.textContent = `Reading photo ${i + 1} of ${list.length} into memory…`;
    const f = list[i] as File;
    try {
      files.push(new File([await f.arrayBuffer()], "", { type: f.type, lastModified: f.lastModified }));
    } catch (e) {
      unread.set(i + 1, `could not be read when picked (${describeError(e, f.name)}) | ${(f.size / 1e6).toFixed(1)} MB, ${Math.round((performance.now() - pickedAt) / 1000)} s after picking`);
      files.push(new File([], "", { type: f.type }));
    }
  }
  copyNote = `copied into memory at pick: ${list.length - unread.size} of ${list.length} read, in ${((performance.now() - pickedAt) / 1000).toFixed(1)} s`;
  for (let i = 0; i < files.length; i++) {
    const notRead = unread.get(i + 1);
    if (notRead !== undefined) {
      failures.set(i + 1, notRead);
      continue;
    }
    ui.status.textContent = `Encoding photo ${i + 1} of ${files.length}…`;
    const r = await encodePhoto(files[i] as File);
    if (typeof r === "string") {
      ui.status.textContent = `Photo ${i + 1} of ${files.length} failed; finding out why…`;
      failures.set(i + 1, `${r} | ${await diagnose(files[i] as File)}`);
      continue;
    }
    decodeTimes.set(i + 1, r.decodeMs);
    const thumbSize = fitLongEdge(r.size, THUMB_LONG_EDGE);
    for (const e of r.encodes) {
      const at = e.kind === "asset" ? r.size : thumbSize;
      rows.push({ photo: i + 1, browser, width: at.width, height: at.height, kind: e.kind, quality: e.quality, bytes: e.bytes.length, encodeMs: e.ms });
    }
    zero(r.encodes);
  }
  busy = false;
  const ok = files.length - failures.size;
  ui.status.textContent = `${ok} of ${files.length} photos measured${failures.size ? `; ${failures.size} failed. Why is shown on each failed photo, and is included when you copy the numbers` : ""}.`;
  renderNumbers();
  ui.numbers.hidden = false;
  if (ok > 0) {
    ui.compare.hidden = false;
    layout();
    void openPhoto([...Array(files.length).keys()].find((i) => !failures.has(i + 1)) ?? 0);
  }
}

// ── Numbers: tables and CSV ────────────────────────────────────────────────

function table(el: HTMLTableElement, head: readonly string[], body: readonly (readonly string[])[]): void {
  el.replaceChildren();
  const tr = (cells: readonly string[], tag: "th" | "td") => {
    const r = document.createElement("tr");
    for (const c of cells) {
      const cell = document.createElement(tag);
      cell.textContent = c;
      r.append(cell);
    }
    return r;
  };
  const thead = document.createElement("thead");
  thead.append(tr(head, "th"));
  const tbody = document.createElement("tbody");
  for (const b of body) tbody.append(tr(b, "td"));
  el.append(thead, tbody);
}

function renderNumbers(): void {
  const sumHead = ["quality", "photos", "median kB", "largest kB", "30-photo album MB", "median ms", "max ms"];
  const sumRow = (s: ReturnType<typeof summarise>[number]) => [s.quality.toFixed(2), String(s.n), kB(s.medianBytes), kB(s.maxBytes), (s.album30 / 1e6).toFixed(2), ms(s.medianMs), ms(s.maxMs)];
  table(ui.sumAsset, sumHead, summarise(rows, "asset", ASSET_QUALITIES).map(sumRow));
  const thumbs = summarise(rows, "thumb", THUMB_QUALITIES);
  table(ui.sumThumb, [...sumHead, "fits one chunk"], thumbs.map((s) => [...sumRow(s), s.n === 0 ? "–" : s.maxBytes <= CHUNK_SIZE ? "yes" : "NO"]));

  const head = ["photo", "size", "decode ms", ...ASSET_QUALITIES.map((q) => `${q.toFixed(2)} kB`), ...THUMB_QUALITIES.map((q) => `thumb ${q.toFixed(2)} kB`)];
  const body = files.map((_, i) => {
    const n = i + 1;
    const failed = failures.get(n);
    if (failed !== undefined) return [String(n), failed];
    const of = rows.filter((r) => r.photo === n);
    const a = of.find((r) => r.kind === "asset");
    const cell = (kind: Kind, q: number) => kB(of.find((r) => r.kind === kind && r.quality === q)?.bytes ?? NaN);
    return [String(n), a ? `${a.width}×${a.height}` : "", ms(decodeTimes.get(n) ?? NaN), ...ASSET_QUALITIES.map((q) => cell("asset", q)), ...THUMB_QUALITIES.map((q) => cell("thumb", q))];
  });
  table(ui.perPhoto, head, body);
  ui.csv.value = report(rows, failures, later, copyNote);
}

ui.copy.addEventListener("click", () => {
  void (async () => {
    // The clipboard API needs a secure context, which plain HTTP on the Wi-Fi is not; the
    // selection and execCommand work on both. Long-press the box if neither does.
    if (window.isSecureContext && navigator.clipboard !== undefined) {
      try {
        await navigator.clipboard.writeText(ui.csv.value);
        ui.copied.textContent = "Copied.";
        return;
      } catch {
        // fall through to the selection
      }
    }
    ui.csv.focus();
    ui.csv.select();
    ui.csv.setSelectionRange(0, ui.csv.value.length);
    ui.copied.textContent = document.execCommand("copy") ? "Copied." : "Select the text above and copy it.";
  })();
});

// ── Comparing: one photo, every quality, in the viewer's own drawing ───────

type Shown = {
  readonly asset: Map<number, ImageBitmap>;
  readonly thumb: Map<number, ImageBitmap>;
  readonly encodes: Map<string, Encode>;
  assetOrder: number[];
  thumbOrder: number[];
};

let shown: Shown | null = null;
/** The photo in the header, shown or failed. */
let current = 0;
let assetQ: number = ASSET_QUALITY;
let thumbQ: number = THUMB_QUALITY;
let view: View = FIT;
let stage: Size = { w: 0, h: 0 };
let revealed = false;
/** A later openPhoto() supersedes an earlier one still encoding. */
let opening = 0;

function closeShown(): void {
  opening++;
  if (shown === null) return;
  for (const b of [...shown.asset.values(), ...shown.thumb.values()]) b.close();
  shown = null;
}

const orders = (): { asset: number[]; thumb: number[] } =>
  ui.blind.checked ? { asset: shuffled(ASSET_QUALITIES, Math.random), thumb: shuffled(THUMB_QUALITIES, Math.random) } : { asset: [...ASSET_QUALITIES], thumb: [...THUMB_QUALITIES] };

async function openPhoto(index: number): Promise<void> {
  closeShown();
  const mine = opening;
  view = FIT;
  current = index;
  ui.which.textContent = `Photo ${index + 1} of ${files.length}`;
  ui.prev.disabled = index === 0;
  ui.next.disabled = index === files.length - 1;
  ui.determinism.textContent = "";
  ui.photoError.hidden = true;
  const failed = failures.get(index + 1);
  if (failed !== undefined) {
    ui.photoError.textContent = `Photo ${index + 1} could not be prepared, so there is nothing to compare. ${failed}`;
    ui.photoError.hidden = false;
    ui.assetNow.textContent = "";
    ui.thumbNow.textContent = "";
    ui.assetQ.replaceChildren();
    ui.thumbQ.replaceChildren();
    clear(ui.photo);
    clear(ui.cell);
    return;
  }
  ui.assetNow.textContent = "Encoding this photo again for the comparison…";
  const file = files[index] as File;
  const r = await encodePhoto(file);
  if (typeof r === "string") {
    if (mine === opening) failAgain(index, "preparing it again", `${r} | ${await diagnose(file)}`);
    return;
  }
  const asset = new Map<number, ImageBitmap>();
  const thumb = new Map<number, ImageBitmap>();
  const encodes = new Map<string, Encode>();
  const drift: string[] = [];
  try {
    for (const e of r.encodes) {
      // As the recipient decodes: bytes to a Blob to a bitmap, no URL.
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(new Blob([e.bytes], { type: "image/jpeg" }));
      } catch (err) {
        for (const b of [...asset.values(), ...thumb.values()]) b.close();
        if (mine === opening) failAgain(index, `showing its ${e.kind} at ${e.quality.toFixed(2)}`, `${describeError(err, file.name)} | picked ${Math.round((performance.now() - pickedAt) / 1000)} s ago; phone memory ${deviceMemory()}`);
        return;
      }
      (e.kind === "asset" ? asset : thumb).set(e.quality, bitmap);
      encodes.set(`${e.kind}${e.quality}`, e);
      const first = rows.find((x) => x.photo === index + 1 && x.kind === e.kind && x.quality === e.quality);
      if (first !== undefined && first.bytes !== e.bytes.length) drift.push(`${e.kind} ${e.quality.toFixed(2)}: ${first.bytes} then ${e.bytes.length} bytes`);
    }
  } finally {
    zero(r.encodes);
  }
  if (mine !== opening) {
    for (const b of [...asset.values(), ...thumb.values()]) b.close();
    return;
  }
  ui.determinism.textContent = drift.length ? `This browser's encoder gave different sizes on a second encode: ${drift.join("; ")}. The table keeps the first.` : "";
  const o = orders();
  shown = { asset, thumb, encodes, assetOrder: o.asset, thumbOrder: o.thumb };
  revealed = false;
  renderButtons();
  draw();
}

/** A photo that measured, failing when opened again: said on the photo, kept for the copied numbers. */
function failAgain(index: number, step: string, why: string): void {
  later.push(`photo ${index + 1}, ${step}: ${why}`);
  ui.photoError.textContent = `Photo ${index + 1} was measured, but failed when opened again (${step}). ${why}`;
  ui.photoError.hidden = false;
  ui.assetNow.textContent = "";
  ui.thumbNow.textContent = "";
  ui.assetQ.replaceChildren();
  ui.thumbQ.replaceChildren();
  clear(ui.photo);
  clear(ui.cell);
  ui.csv.value = report(rows, failures, later, copyNote);
}

function clear(c: HTMLCanvasElement): void {
  c.getContext("2d")?.clearRect(0, 0, c.width, c.height);
}

/** In blind mode a button is a letter, in a shuffled order, until Reveal. */
function renderButtons(): void {
  const s = shown;
  if (s === null) return;
  const blind = ui.blind.checked;
  ui.reveal.hidden = !blind || revealed;
  const make = (box: HTMLElement, order: readonly number[], current: number, pick: (q: number) => void) => {
    box.replaceChildren(
      ...order.map((q, i) => {
        const b = document.createElement("button");
        b.type = "button";
        const letter = String.fromCharCode(65 + i);
        b.textContent = !blind ? q.toFixed(2) : revealed ? `${letter} = ${q.toFixed(2)}` : letter;
        b.setAttribute("aria-pressed", String(q === current));
        b.addEventListener("click", () => pick(q));
        return b;
      }),
    );
  };
  make(ui.assetQ, s.assetOrder, assetQ, (q) => {
    assetQ = q;
    renderButtons();
    draw();
  });
  make(ui.thumbQ, s.thumbOrder, thumbQ, (q) => {
    thumbQ = q;
    renderButtons();
    draw();
  });
  const now = (kind: Kind, order: readonly number[], q: number) => {
    const e = s.encodes.get(`${kind}${q}`);
    const letter = String.fromCharCode(65 + order.indexOf(q));
    const facts = e ? `${kB(e.bytes.length)} kB · encode ${ms(e.ms)} ms` : "";
    if (blind && !revealed) return `Showing ${letter}`;
    return `${blind ? `${letter} = ` : ""}${q.toFixed(2)} · ${facts}`;
  };
  ui.assetNow.textContent = now("asset", s.assetOrder, assetQ);
  ui.thumbNow.textContent = now("thumb", s.thumbOrder, thumbQ);
}

/** The viewport the viewer is imagined in: this window, or a phone's. */
function viewport(): { w: number; h: number } {
  const v = ui.frame.value;
  if (v === "window") return { w: document.documentElement.clientWidth, h: window.innerHeight };
  const [w, h] = v.split("x").map(Number);
  return { w: w ?? 390, h: h ?? 844 };
}

/** Sizes the stage as Viewer.svelte's and the cell as Grid.svelte's, in that viewport. */
function layout(): void {
  const vp = viewport();
  const st = viewerStage(vp);
  // In this window the viewer's stage is edge to edge; the section's padding is undone.
  ui.stage.classList.toggle("bleed", ui.frame.value === "window");
  ui.stage.style.width = `${st.w}px`;
  ui.stage.style.height = `${Math.round(st.h)}px`;
  const cell = gridCell(vp.w);
  ui.cell.parentElement?.style.setProperty("width", `${cell}px`);
  ui.cell.parentElement?.style.setProperty("height", `${cell}px`);
  ui.device.textContent = `${browser} · devicePixelRatio ${dpr()} · window ${document.documentElement.clientWidth}×${window.innerHeight}`;
  draw();
  ui.stageNote.textContent = `Viewer stage ${stage.w}×${stage.h} CSS px, grid cell ${ui.cell.clientWidth} px, at devicePixelRatio ${dpr()}. Maximum zoom is ${MAX_SCALE}×.`;
}

/** Fits a canvas's backing store to its CSS size at this pixel ratio, as Viewer.svelte does. */
function backing(c: HTMLCanvasElement): { ctx: CanvasRenderingContext2D | null; size: Size } {
  const size = { w: c.clientWidth, h: c.clientHeight };
  const w = Math.round(size.w * dpr());
  const h = Math.round(size.h * dpr());
  if (c.width !== w) c.width = w;
  if (c.height !== h) c.height = h;
  return { ctx: c.getContext("2d", { colorSpace: "srgb" }), size };
}

function draw(): void {
  const p = backing(ui.photo);
  stage = p.size;
  const s = shown;
  if (s === null || stage.w === 0 || stage.h === 0) return;
  const pic = s.asset.get(assetQ);
  if (pic !== undefined && p.ctx !== null) {
    view = clampView(pic, stage, view);
    drawViewer(p.ctx, pic, stage, dpr(), view, "");
  }
  const c = backing(ui.cell);
  const t = s.thumb.get(thumbQ);
  if (t !== undefined && c.ctx !== null && c.size.w > 0) drawCell(c.ctx, t, c.size.w, dpr(), "");
  const zoom = (target: number) => Math.abs(view.scale - target) < 1e-3;
  ui.fit.setAttribute("aria-pressed", String(zoom(1)));
  ui.z2.setAttribute("aria-pressed", String(zoom(DOUBLE_TAP_SCALE)));
  ui.zmax.setAttribute("aria-pressed", String(zoom(MAX_SCALE)));
}

function zoomTo(scale: number): void {
  const pic = shown?.asset.get(assetQ);
  if (pic === undefined) return;
  const c = { x: stage.w / 2, y: stage.h / 2 };
  view = scale === 1 ? FIT : moveView(pic, stage, view, scale, c, c);
  draw();
}

const gestures = new Gestures(
  () => {
    const pic = shown?.asset.get(assetQ);
    return pic !== undefined && stage.w > 0 ? { pic, stage, view } : null;
  },
  (v) => {
    view = v;
    draw();
  },
);

{
  const f = ui.stage;
  const at = (e: PointerEvent) => {
    const r = f.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  f.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    gestures.down(e.pointerId, at(e), e.timeStamp);
    try {
      f.setPointerCapture(e.pointerId);
    } catch {
      // not an active pointer
    }
  });
  f.addEventListener("pointermove", (e) => gestures.move(e.pointerId, at(e)));
  f.addEventListener("pointerup", (e) => gestures.up(e.pointerId, at(e), e.timeStamp));
  f.addEventListener("pointercancel", (e) => gestures.cancel(e.pointerId));
}

ui.fit.addEventListener("click", () => zoomTo(1));
ui.z2.addEventListener("click", () => zoomTo(DOUBLE_TAP_SCALE));
ui.zmax.addEventListener("click", () => zoomTo(MAX_SCALE));
ui.prev.addEventListener("click", () => {
  if (!busy && current > 0) void openPhoto(current - 1);
});
ui.next.addEventListener("click", () => {
  if (!busy && current < files.length - 1) void openPhoto(current + 1);
});

ui.blind.addEventListener("change", () => {
  if (shown === null) return;
  const o = orders();
  shown.assetOrder = o.asset;
  shown.thumbOrder = o.thumb;
  revealed = false;
  renderButtons();
});
ui.reveal.addEventListener("click", () => {
  revealed = true;
  renderButtons();
});
ui.frame.addEventListener("change", layout);
window.addEventListener("resize", layout);

// Keys, for the Mac: 1–5 pick the photo's quality buttons in the order shown, f fits, z zooms all the way.
document.addEventListener("keydown", (e) => {
  if (shown === null || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  const n = Number(e.key);
  if (Number.isInteger(n) && n >= 1 && n <= shown.assetOrder.length) {
    assetQ = shown.assetOrder[n - 1] as number;
    renderButtons();
    draw();
  } else if (e.key === "f") zoomTo(1);
  else if (e.key === "z") zoomTo(MAX_SCALE);
});

ui.files.addEventListener("change", () => {
  const list = [...(ui.files.files ?? [])];
  if (list.length === 0 || busy) return;
  void measure(list);
});

ui.device.textContent = `${browser} · devicePixelRatio ${dpr()} · window ${document.documentElement.clientWidth}×${window.innerHeight}`;
// Narrower than a tablet: this window is the phone. Wider: a phone's viewport inside it.
ui.frame.value = document.documentElement.clientWidth < 600 ? "window" : "390x844";
