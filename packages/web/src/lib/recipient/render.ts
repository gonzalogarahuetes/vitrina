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

/** The steps the zoom buttons move through. Gestures may stop anywhere between the ends. */
export const ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;
export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Where a double tap on a fitted photo zooms to. */
export const DOUBLE_TAP_SCALE = 2;
const EPS = 1e-3;

/** `scale` is relative to fitted (1); x and y offset the photo from centred, in CSS pixels. */
export type View = { readonly scale: number; readonly x: number; readonly y: number };
export const FIT: View = { scale: 1, x: 0, y: 0 };

export type Point = { readonly x: number; readonly y: number };

export const clampScale = (s: number): number => (Number.isFinite(s) ? Math.max(MIN_SCALE, Math.min(MAX_SCALE, s)) : MIN_SCALE);

const fitOf = (pic: Dims, stage: Size): number => Math.min(stage.w / pic.width, stage.h / pic.height);

/** The photo's rectangle on the stage: contained at scale 1, scaled about the centre, offset by the pan. */
export function photoRect(pic: Dims, stage: Size, view: View): Rect {
  const scale = fitOf(pic, stage) * clampScale(view.scale);
  const w = pic.width * scale;
  const h = pic.height * scale;
  return { x: (stage.w - w) / 2 + view.x, y: (stage.h - h) / 2 + view.y, w, h };
}

/** How far the pan may go on each axis: the photo's edge stops at the stage's edge. */
export function panLimits(pic: Dims, stage: Size, scale: number): { x: number; y: number } {
  const r = photoRect(pic, stage, { scale, x: 0, y: 0 });
  return { x: Math.max(0, (r.w - stage.w) / 2), y: Math.max(0, (r.h - stage.h) / 2) };
}

export function clampView(pic: Dims, stage: Size, view: View): View {
  const scale = clampScale(view.scale);
  const lim = panLimits(pic, stage, scale);
  const clamp = (v: number, l: number) => (l === 0 || !Number.isFinite(v) ? 0 : Math.max(-l, Math.min(l, v)));
  return { scale, x: clamp(view.x, lim.x), y: clamp(view.y, lim.y) };
}

/**
 * Every zoom and pan, by button or by gesture: zoom to `scale`, and put the
 * point of the photo that was under `from` under `to` (stage coordinates),
 * then stop at the photo's edges. A drag is `scale` unchanged; a zoom about a
 * point is `from` = `to`; a pinch is both at once.
 */
export function moveView(pic: Dims, stage: Size, view: View, scale: number, from: Point, to: Point): View {
  const r = photoRect(pic, stage, view);
  const fx = r.w > 0 ? (from.x - r.x) / r.w : 0.5;
  const fy = r.h > 0 ? (from.y - r.y) / r.h : 0.5;
  const s = clampScale(scale);
  const w = pic.width * fitOf(pic, stage) * s;
  const h = pic.height * fitOf(pic, stage) * s;
  return clampView(pic, stage, { scale: s, x: to.x - fx * w - (stage.w - w) / 2, y: to.y - fy * h - (stage.h - h) / 2 });
}

const centre = (stage: Size): Point => ({ x: stage.w / 2, y: stage.h / 2 });

/** The buttons: one step of ZOOM_LEVELS, keeping the same point of the photo at the centre of the stage. */
export function zoomBy(pic: Dims, stage: Size, view: View, dir: 1 | -1): View {
  const s = view.scale;
  const next = dir > 0 ? (ZOOM_LEVELS.find((l) => l > s + EPS) ?? MAX_SCALE) : ([...ZOOM_LEVELS].reverse().find((l) => l < s - EPS) ?? MIN_SCALE);
  return moveView(pic, stage, view, next, centre(stage), centre(stage));
}

/** A double tap: zoomed in about the tapped point from fitted; back to fitted from anything else. */
export function doubleTap(pic: Dims, stage: Size, view: View, at: Point): View {
  return isFitted(view) ? moveView(pic, stage, view, DOUBLE_TAP_SCALE, at, at) : FIT;
}

export const isFitted = (view: View): boolean => view.scale <= MIN_SCALE + EPS;
export const canZoom = (view: View): { in: boolean; out: boolean } => ({ in: view.scale < MAX_SCALE - EPS, out: view.scale > MIN_SCALE + EPS });

export type Direction = "up" | "down" | "left" | "right";

/** "Move up" shows more of the top of the photo: the photo moves down. */
export function panBy(pic: Dims, stage: Size, view: View, dir: Direction): View {
  const sx = stage.w * 0.25;
  const sy = stage.h * 0.25;
  const d = { up: [0, sy], down: [0, -sy], left: [sx, 0], right: [-sx, 0] }[dir];
  return clampView(pic, stage, { scale: view.scale, x: view.x + (d[0] ?? 0), y: view.y + (d[1] ?? 0) });
}

export function canPan(pic: Dims, stage: Size, view: View): Record<Direction, boolean> {
  const lim = panLimits(pic, stage, view.scale);
  const eps = 0.5;
  return { up: view.y < lim.y - eps, down: view.y > -lim.y + eps, left: view.x < lim.x - eps, right: view.x > -lim.x + eps };
}

// ── Pan arrows on the photo (brief §11: explicit controls, a requirement) ──

/** The arrows' size and their distance from the stage's edge. Viewer.svelte's CSS uses the same numbers. */
export const ARROW_PX = 60;
export const ARROW_INSET_PX = 8;
/** The gap the watermark keeps from any arrow. */
export const ARROW_CLEARANCE_PX = 6;

/**
 * Which pan arrows are on screen, and where (stage CSS pixels): only on an
 * axis the photo can pan along at this zoom, so only while zoomed in, each
 * centred on its edge of the stage. On a pannable axis the photo overflows the
 * stage, so that edge is the photo's visible edge.
 */
export function panArrows(pic: Dims, stage: Size, view: View): Partial<Record<Direction, Rect>> {
  const lim = panLimits(pic, stage, view.scale);
  const eps = 0.5;
  const out: Partial<Record<Direction, Rect>> = {};
  const midX = stage.w / 2 - ARROW_PX / 2;
  const midY = stage.h / 2 - ARROW_PX / 2;
  if (lim.y > eps) {
    out.up = { x: midX, y: ARROW_INSET_PX, w: ARROW_PX, h: ARROW_PX };
    out.down = { x: midX, y: stage.h - ARROW_INSET_PX - ARROW_PX, w: ARROW_PX, h: ARROW_PX };
  }
  if (lim.x > eps) {
    out.left = { x: ARROW_INSET_PX, y: midY, w: ARROW_PX, h: ARROW_PX };
    out.right = { x: stage.w - ARROW_INSET_PX - ARROW_PX, y: midY, w: ARROW_PX, h: ARROW_PX };
  }
  return out;
}

// ── Watermark (brief §5, §16: "Screenshots leave marks") ───────────────────

export const FONT_STACK = "'Atkinson Hyperlegible', Verdana, sans-serif";

/** Translucent white, with a soft dark shadow so it reads on light and dark photos alike. No box. */
export const WATERMARK_FILL = "rgba(255, 255, 255, 0.78)";
export const WATERMARK_SHADOW = "rgba(0, 0, 0, 0.8)";

/**
 * Where the watermark's text goes: right-aligned, its bottom edge `inset`
 * inside the bottom-right corner of `seen`, which callers pass as the visible
 * part of the photo, so the text is over the photo and inside the capture.
 *
 * `avoid` is what must stay uncovered: the pan arrows. The text's width is
 * limited so it ends short of any arrow beside it. Where that would squeeze
 * it below 80% of its natural width `textW` (a long name on a narrow phone,
 * beside the bottom arrow), it is lifted to sit just above the arrows instead,
 * still against the photo's right edge, whichever leaves it wider.
 */
export function watermarkPlace(
  seen: Rect,
  fontPx: number,
  textW = 0,
  avoid: readonly Rect[] = [],
): { x: number; y: number; inset: number; maxW: number; fontPx: number } {
  // A very wide, very short photo: the text shrinks to fit its height rather than spill into the margin.
  const font = Math.max(1, Math.min(fontPx, seen.h / 2));
  const inset = Math.min(font * 0.6, seen.w / 4);
  const right = seen.x + seen.w - inset;
  const fullW = Math.max(1, seen.w - 2 * inset);
  /** The width available for a line whose bottom is `bottom`, ending at `right`. */
  const widthAt = (bottom: number): number => {
    let left = right - fullW;
    for (const r of avoid) {
      const overlapsBand = r.y < bottom + ARROW_CLEARANCE_PX && r.y + r.h > bottom - font - ARROW_CLEARANCE_PX;
      if (!overlapsBand || r.x >= right + ARROW_CLEARANCE_PX) continue;
      // An arrow over the line's right end leaves no room at all on this line.
      left = r.x + r.w + ARROW_CLEARANCE_PX > right ? right : Math.max(left, r.x + r.w + ARROW_CLEARANCE_PX);
    }
    return Math.max(0, right - left);
  };
  const corner = seen.y + seen.h - inset;
  const atCorner = widthAt(corner);
  const wanted = Math.min(textW, fullW);
  if (avoid.length === 0 || atCorner >= wanted * 0.8) return { x: right, y: corner, inset, maxW: Math.max(1, atCorner), fontPx: font };
  // Just above the arrows that cross the corner line where the full text would be.
  const inWay = avoid.filter(
    (r) =>
      r.x < right + ARROW_CLEARANCE_PX &&
      r.x + r.w > right - wanted - ARROW_CLEARANCE_PX &&
      r.y < corner + ARROW_CLEARANCE_PX &&
      r.y + r.h > corner - font - ARROW_CLEARANCE_PX,
  );
  const lifted = Math.min(...inWay.map((r) => r.y)) - ARROW_CLEARANCE_PX;
  const aboveW = lifted - font >= seen.y ? widthAt(lifted) : 0;
  return aboveW > atCorner
    ? { x: right, y: lifted, inset, maxW: Math.max(1, aboveW), fontPx: font }
    : { x: right, y: corner, inset, maxW: Math.max(1, atCorner), fontPx: font };
}

/**
 * One short line in the bottom-right corner of `seen`, drawn into the pixels.
 * fillText's maxWidth squeezes a long label to fit rather than let it pass
 * the photo's left edge. An empty `text` draws nothing: the owner's own view
 * has no recipient (brief §5 names the recipient).
 */
export function drawWatermark(ctx: Ctx, text: string, seen: Rect, fontPx: number, avoid: readonly Rect[] = []): void {
  if (text === "" || seen.w <= 0 || seen.h <= 0) return;
  ctx.save();
  ctx.font = `700 ${watermarkPlace(seen, fontPx).fontPx}px ${FONT_STACK}`;
  const p = watermarkPlace(seen, fontPx, ctx.measureText(text).width, avoid);
  ctx.textAlign = "right";
  // "bottom" is the em box's bottom, so descenders stay above the inset too.
  ctx.textBaseline = "bottom";
  ctx.fillStyle = WATERMARK_FILL;
  ctx.shadowColor = WATERMARK_SHADOW;
  // A tight shadow, drawn twice: one pass is lost against a white sky (checked on rendered pixels).
  ctx.shadowBlur = Math.max(1.5, p.fontPx * 0.18);
  ctx.shadowOffsetY = 1;
  ctx.fillText(text, p.x, p.y, p.maxW);
  ctx.fillText(text, p.x, p.y, p.maxW);
  ctx.restore();
}

/** The part of `r` inside the stage. */
export function visible(r: Rect, stage: Size): Rect {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  return { x, y, w: Math.max(0, Math.min(stage.w, r.x + r.w) - x), h: Math.max(0, Math.min(stage.h, r.y + r.h) - y) };
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

export const VIEWER_STAGE = "#2A2824";
export const VIEWER_WATERMARK_PX = 15;

/**
 * The viewer: the photo at the current zoom and pan, drawn from the decoded
 * bitmap at that scale (never a scaled copy of an earlier frame), then the
 * watermark in the corner of the part of the photo that is on screen, so it
 * stays in view and over the photo at any zoom or pan, and never sits in the
 * letterbox, and clear of the pan arrows shown at this view (panArrows).
 * `blur` is the stand-in thumbnail's state while the full photo loads.
 */
export function drawViewer(ctx: Ctx, pic: Picture, stage: Size, dpr: number, view: View, watermark: string, blur = false): void {
  prepare(ctx, stage, dpr, VIEWER_STAGE);
  const r = photoRect(pic, stage, view);
  ctx.save();
  if (blur) ctx.filter = "blur(6px)";
  ctx.drawImage(pic as unknown as CanvasImageSource, r.x, r.y, r.w, r.h);
  ctx.restore();
  drawWatermark(ctx, watermark, visible(r, stage), VIEWER_WATERMARK_PX, Object.values(panArrows(pic, stage, view)));
}

/** A cell's watermark size: legible on a phone's two-column grid, never larger than the viewer's. */
export const cellWatermarkPx = (size: number): number => Math.min(VIEWER_WATERMARK_PX, Math.max(9, Math.round(size / 15)));

/** A grid cell: the thumbnail cropped to cover the square, the watermark in its corner. */
export function drawCell(ctx: Ctx, pic: Picture, size: number, dpr: number, watermark: string): void {
  const stage = { w: size, h: size };
  prepare(ctx, stage, dpr, "#E4E1DA");
  const scale = Math.max(size / pic.width, size / pic.height);
  const w = pic.width * scale;
  const h = pic.height * scale;
  ctx.drawImage(pic as unknown as CanvasImageSource, (size - w) / 2, (size - h) / 2, w, h);
  // Cropped to cover, so the whole square is photo.
  drawWatermark(ctx, watermark, { x: 0, y: 0, w: size, h: size }, cellWatermarkPx(size));
}
