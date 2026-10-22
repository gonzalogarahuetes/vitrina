/*
 * Canvas drawing for the grid and the viewer (brief §10: canvas only). The
 * watermark is drawn into the same pixels as the photo, last, so a capture
 * of the canvas carries it (brief §5). It is never an HTML element over the
 * canvas.
 *
 * Coordinates are CSS pixels; `dpr` scales the backing store.
 */

export type Size = { readonly w: number; readonly h: number };
/** A picture's own dimensions, as ImageBitmap names them. */
export type Dims = { readonly width: number; readonly height: number };
export type Rect = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };

/** What the drawing needs from a decoded image; ImageBitmap satisfies it. */
export type Picture = Dims & { close(): void };

/** The subset of CanvasRenderingContext2D used here, so tests can record calls. */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | "setTransform"
  | "clearRect"
  | "fillRect"
  | "drawImage"
  | "fillText"
  | "measureText"
  | "save"
  | "restore"
  | "beginPath"
  | "roundRect"
  | "fill"
  | "font"
  | "fillStyle"
  | "textAlign"
  | "textBaseline"
  | "shadowColor"
  | "shadowBlur"
  | "shadowOffsetY"
  | "filter"
  | "imageSmoothingQuality"
>;

// ── Zoom and pan (brief §11: explicit controls, a requirement) ─────────────

export const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;

export type View = { readonly zoom: number; readonly x: number; readonly y: number };
export const FIT: View = { zoom: 0, x: 0, y: 0 };

/** The photo's rectangle on the stage: contained at zoom 1, scaled about the centre, offset by the pan. */
export function photoRect(pic: Dims, stage: Size, view: View): Rect {
  const fit = Math.min(stage.w / pic.width, stage.h / pic.height);
  const scale = fit * (ZOOM_LEVELS[view.zoom] ?? 1);
  const w = pic.width * scale;
  const h = pic.height * scale;
  return { x: (stage.w - w) / 2 + view.x, y: (stage.h - h) / 2 + view.y, w, h };
}

/** How far the pan may go on each axis: the photo's edge stops at the stage's edge. */
export function panLimits(pic: Dims, stage: Size, zoom: number): { x: number; y: number } {
  const r = photoRect(pic, stage, { zoom, x: 0, y: 0 });
  return { x: Math.max(0, (r.w - stage.w) / 2), y: Math.max(0, (r.h - stage.h) / 2) };
}

export function clampView(pic: Dims, stage: Size, view: View): View {
  const zoom = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, view.zoom));
  const lim = panLimits(pic, stage, zoom);
  const clamp = (v: number, l: number) => (l === 0 ? 0 : Math.max(-l, Math.min(l, v)));
  return { zoom, x: clamp(view.x, lim.x), y: clamp(view.y, lim.y) };
}

export function zoomBy(pic: Dims, stage: Size, view: View, delta: number): View {
  const zoom = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, view.zoom + delta));
  // Keep the same point of the photo at the centre of the stage.
  const k = (ZOOM_LEVELS[zoom] ?? 1) / (ZOOM_LEVELS[view.zoom] ?? 1);
  return clampView(pic, stage, { zoom, x: view.x * k, y: view.y * k });
}

export type Direction = "up" | "down" | "left" | "right";

/** "Move up" shows more of the top of the photo: the photo moves down. */
export function panBy(pic: Dims, stage: Size, view: View, dir: Direction): View {
  const sx = stage.w * 0.25;
  const sy = stage.h * 0.25;
  const d = { up: [0, sy], down: [0, -sy], left: [sx, 0], right: [-sx, 0] }[dir];
  return clampView(pic, stage, { zoom: view.zoom, x: view.x + (d[0] ?? 0), y: view.y + (d[1] ?? 0) });
}

export function canPan(pic: Dims, stage: Size, view: View): Record<Direction, boolean> {
  const lim = panLimits(pic, stage, view.zoom);
  const eps = 0.5;
  return { up: view.y < lim.y - eps, down: view.y > -lim.y + eps, left: view.x < lim.x - eps, right: view.x > -lim.x + eps };
}

// ── Watermark ──────────────────────────────────────────────────────────────

export const FONT_STACK = "'Atkinson Hyperlegible', Verdana, sans-serif";

/**
 * Two lines centred on (cx, cy), white over a translucent pill, as the
 * prototype draws it. Clipped to nothing: its position is chosen inside the
 * visible part of the photo by the callers.
 */
export function drawWatermark(ctx: Ctx, lines: readonly string[], cx: number, cy: number, fontPx: number, maxW: number): void {
  // The owner's own view has no recipient label, so nothing to draw (brief §5 names the recipient).
  if (lines.length === 0) return;
  ctx.save();
  ctx.font = `700 ${fontPx}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const lineH = fontPx * 1.3;
  const padX = fontPx * 0.75;
  const padY = fontPx * 0.5;
  const textW = Math.min(maxW - 2 * padX, Math.max(...lines.map((l) => ctx.measureText(l).width)));
  const boxW = textW + 2 * padX;
  const boxH = lines.length * lineH + 2 * padY;
  ctx.fillStyle = "rgba(28, 27, 25, 0.32)";
  ctx.beginPath();
  ctx.roundRect(cx - boxW / 2, cy - boxH / 2, boxW, boxH, fontPx * 0.6);
  ctx.fill();
  ctx.fillStyle = "#FFFFFF";
  ctx.shadowColor = "rgba(0, 0, 0, 0.75)";
  ctx.shadowBlur = fontPx * 0.2;
  ctx.shadowOffsetY = 1;
  lines.forEach((line, i) => {
    ctx.fillText(line, cx, cy - boxH / 2 + padY + lineH * (i + 0.5), textW);
  });
  ctx.restore();
}

/** The part of `r` inside the stage. */
export function visible(r: Rect, stage: Size): Rect {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { x, y, w: Math.max(0, Math.min(stage.w, r.x + r.w) - x), h: Math.max(0, Math.min(stage.h, r.y + r.h) - y) };
}

/** Where the prototype puts it: centred across, about two thirds down the visible photo. */
export function watermarkAnchor(seen: Rect): { cx: number; cy: number } {
  return { cx: seen.x + seen.w / 2, cy: seen.y + seen.h * 0.65 };
}

function prepare(ctx: Ctx, stage: Size, dpr: number, background: string | null): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, stage.w, stage.h);
  if (background !== null) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, stage.w, stage.h);
  }
  ctx.imageSmoothingQuality = "high";
}

/**
 * The viewer: the photo at the current zoom and pan, then the watermark fixed
 * to the visible part of the photo, so it stays in view at any zoom or pan.
 * `blur` is the stand-in thumbnail's state while the full photo loads.
 */
export function drawViewer(ctx: Ctx, pic: Picture, stage: Size, dpr: number, view: View, lines: readonly string[], blur = false): void {
  prepare(ctx, stage, dpr, "#2A2824");
  const r = photoRect(pic, stage, view);
  ctx.save();
  if (blur) ctx.filter = "blur(6px)";
  ctx.drawImage(pic as unknown as CanvasImageSource, r.x, r.y, r.w, r.h);
  ctx.restore();
  const seen = visible(r, stage);
  const { cx, cy } = watermarkAnchor(seen);
  drawWatermark(ctx, lines, cx, cy, 16, seen.w);
}

/** A grid cell: the thumbnail cropped to cover the square, the watermark inside it. */
export function drawCell(ctx: Ctx, pic: Picture, size: number, dpr: number, lines: readonly string[]): void {
  const stage = { w: size, h: size };
  prepare(ctx, stage, dpr, "#E4E1DA");
  const scale = Math.max(size / pic.width, size / pic.height);
  const w = pic.width * scale;
  const h = pic.height * scale;
  ctx.drawImage(pic as unknown as CanvasImageSource, (size - w) / 2, (size - h) / 2, w, h);
  const { cx, cy } = watermarkAnchor({ x: 0, y: 0, w: size, h: size });
  drawWatermark(ctx, lines, cx, cy, Math.max(10, Math.round(size / 15)), size - 12);
}
