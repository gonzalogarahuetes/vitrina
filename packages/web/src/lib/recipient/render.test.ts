import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ARROW_CLEARANCE_PX,
  ARROW_INSET_PX,
  ARROW_PX,
  FIT,
  MAX_SCALE,
  ZOOM_LEVELS,
  canPan,
  canZoom,
  cellWatermarkPx,
  clampView,
  doubleTap,
  drawCell,
  drawViewer,
  moveView,
  panArrows,
  panBy,
  photoRect,
  visible,
  zoomBy,
  type Ctx,
  type Picture,
  type Rect,
  type View,
} from "./render";

const PIC: Picture = { width: 1600, height: 1200, close: () => undefined };
const PORTRAIT: Picture = { width: 900, height: 1600, close: () => undefined };
/** A very wide, very short photo: the fitted photo is a thin strip with letterbox above and below. */
const STRIP: Picture = { width: 1600, height: 40, close: () => undefined };
const STAGE = { w: 390, h: 520 };
/** What the recorder's measureText says a character is wide. */
const CHAR_W = 8;

type Op =
  | { op: "drawImage"; rect: Rect }
  | { op: "fillText"; text: string; x: number; y: number; maxWidth: number | undefined; font: string; align: string; baseline: string; fill: string; shadow: string };

/** A context that records what reaches the pixels, in order, with the state each text was drawn in. */
function recorder(): { ctx: Ctx; ops: Op[] } {
  const ops: Op[] = [];
  const ctx = {
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    measureText: (t: string) => ({ width: t.length * CHAR_W }),
    drawImage: (_: unknown, x: number, y: number, w: number, h: number) => void ops.push({ op: "drawImage", rect: { x, y, w, h } }),
    fillText(text: string, x: number, y: number, maxWidth?: number) {
      ops.push({ op: "fillText", text, x, y, maxWidth, font: this.font, align: this.textAlign, baseline: this.textBaseline, fill: this.fillStyle, shadow: this.shadowColor });
    },
    font: "",
    fillStyle: "",
    textAlign: "start",
    textBaseline: "alphabetic",
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetY: 0,
    filter: "none",
    imageSmoothingQuality: "low",
  };
  return { ctx: ctx as unknown as Ctx, ops };
}

const MARK = "María Fernández · 6 Aug 2026";

/**
 * The watermark's draws. It is filled more than once at one spot (a second
 * pass strengthens its shadow), so this checks every draw is the same line in
 * the same place, and returns the first of each distinct line.
 */
const texts = (ops: Op[]) => {
  const all = ops.flatMap((o, i) => (o.op === "fillText" ? [{ ...o, i }] : []));
  const first = all.filter((t, n) => all.findIndex((u) => u.text === t.text && u.x === t.x && u.y === t.y && u.font === t.font) === n);
  return first;
};
const fontPx = (font: string) => Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]);

/**
 * The box a right-aligned, bottom-baseline line occupies: from x - width to x,
 * and from y - fontPx to y. Width is what fillText's maxWidth lets it be.
 */
function textBox(t: Extract<Op, { op: "fillText" }>): Rect {
  const w = Math.min(t.text.length * CHAR_W, t.maxWidth ?? Infinity);
  const px = fontPx(t.font);
  return { x: t.x - w, y: t.y - px, w, h: px };
}

const inside = (a: Rect, b: Rect) => a.x >= b.x - 1e-9 && a.y >= b.y - 1e-9 && a.x + a.w <= b.x + b.w + 1e-9 && a.y + a.h <= b.y + b.h + 1e-9;

describe("the watermark: one short line, drawn into the pixels, in a corner of the photo on screen", () => {
  /** Each view as the viewer would hold it for `pic`: clamped, so panned "to an edge" means as far as that photo goes. */
  const edges = (pic: Picture): [string, View][] => [
    ["fitted", FIT],
    ["at maximum zoom, centred", { scale: MAX_SCALE, x: 0, y: 0 }],
    ["at maximum zoom, panned to the top-left corner", clampView(pic, STAGE, { scale: MAX_SCALE, x: 1e6, y: 1e6 })],
    ["at maximum zoom, panned to the top-right corner", clampView(pic, STAGE, { scale: MAX_SCALE, x: -1e6, y: 1e6 })],
    ["at maximum zoom, panned to the bottom-left corner", clampView(pic, STAGE, { scale: MAX_SCALE, x: 1e6, y: -1e6 })],
    ["at maximum zoom, panned to the bottom-right corner", clampView(pic, STAGE, { scale: MAX_SCALE, x: -1e6, y: -1e6 })],
    ["at maximum zoom, panned to the left edge", clampView(pic, STAGE, { scale: MAX_SCALE, x: 1e6, y: 0 })],
    ["at maximum zoom, panned to the top edge", clampView(pic, STAGE, { scale: MAX_SCALE, x: 0, y: 1e6 })],
    ["at a pinch's in-between scale, panned", clampView(pic, STAGE, { scale: 2.37, x: 140, y: -90 })],
  ];
  for (const pic of [PIC, PORTRAIT, STRIP]) {
    for (const [what, view] of edges(pic)) {
      it(`${pic.width}×${pic.height}, ${what}: after the photo, wholly inside the stage and over the photo, never the margin`, () => {
        const { ctx, ops } = recorder();
        drawViewer(ctx, pic, STAGE, 2, view, MARK);
        const t = texts(ops);
        expect(ops[0]?.op).toBe("drawImage");
        expect(t.map((x) => x.text)).toEqual([MARK]);
        const [line] = t;
        if (line === undefined) throw new Error("no watermark");
        expect(line.i).toBeGreaterThan(0);
        const seen = visible(photoRect(pic, STAGE, view), STAGE);
        expect(inside(textBox(line), seen), `text box ${JSON.stringify(textBox(line))} inside the visible photo ${JSON.stringify(seen)}`).toBe(true);
        // The bottom-right corner of what is on screen of the photo.
        expect(line.align).toBe("right");
        expect(line.baseline).toBe("bottom");
        expect(seen.x + seen.w - line.x).toBeLessThan(16);
        // In the corner, or, where the bottom arrow would be in the way, just above it.
        const down = panArrows(pic, STAGE, view).down;
        if (down === undefined || seen.y + seen.h - line.y < 16) expect(seen.y + seen.h - line.y).toBeLessThan(16);
        else expect(line.y).toBeLessThanOrEqual(down.y - ARROW_CLEARANCE_PX);
      });
    }
  }

  it("translucent, with a soft shadow, and no box behind it", () => {
    const { ctx, ops } = recorder();
    const calls: string[] = [];
    const spy = new Proxy(ctx, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv) as unknown;
        if (typeof v === "function") return (...a: unknown[]) => (calls.push(String(prop)), (v as (...a: unknown[]) => unknown).apply(target, a));
        return v;
      },
    });
    drawViewer(spy, PIC, STAGE, 1, FIT, MARK);
    const [line] = texts(ops);
    expect(line?.fill).toMatch(/^rgba\(255, 255, 255, 0\.[0-9]+\)$/);
    expect(line?.shadow).toMatch(/^rgba\(0, 0, 0, 0\.[0-9]+\)$/);
    expect(calls.filter((c) => /roundRect|fillRect|rect|fill$/.test(c) && c !== "fillText")).toEqual(["fillRect"]); // the stage background only
  });

  it("stays in the same corner of the screen however far the photo is panned", () => {
    const at = (view: View) => texts((() => { const r = recorder(); drawViewer(r.ctx, PIC, STAGE, 1, view, MARK); return r.ops; })()).map((t) => [t.x, t.y]);
    expect(at(clampView(PIC, STAGE, { scale: MAX_SCALE, x: 1e6, y: 1e6 }))).toEqual(at(clampView(PIC, STAGE, { scale: MAX_SCALE, x: -1e6, y: -1e6 })));
  });

  it("a long label is squeezed to fit the photo's width rather than run past its edge", () => {
    const { ctx, ops } = recorder();
    const long = `${"Bartolomé de las Casas y Fernández".repeat(2)} · 6 Aug 2026`;
    drawViewer(ctx, PORTRAIT, STAGE, 1, FIT, long);
    const [line] = texts(ops);
    const seen = visible(photoRect(PORTRAIT, STAGE, FIT), STAGE);
    expect(long.length * CHAR_W).toBeGreaterThan(seen.w);
    expect(line?.maxWidth).toBeLessThan(seen.w);
    if (line !== undefined) expect(inside(textBox(line), seen)).toBe(true);
  });

  it("the owner's own view draws none", () => {
    const { ctx, ops } = recorder();
    drawViewer(ctx, PIC, STAGE, 1, FIT, "");
    expect(texts(ops)).toEqual([]);
  });

  for (const size of [72, 140, 180, 320]) {
    it(`a ${size}px thumbnail carries it in its corner, inside the cell's pixels`, () => {
      const { ctx, ops } = recorder();
      drawCell(ctx, PORTRAIT, size, 2, MARK);
      expect(ops[0]?.op).toBe("drawImage");
      const [line] = texts(ops);
      expect(line?.text).toBe(MARK);
      if (line === undefined) return;
      expect(fontPx(line.font)).toBe(cellWatermarkPx(size));
      expect(inside(textBox(line), { x: 0, y: 0, w: size, h: size })).toBe(true);
      expect(size - line.x).toBeLessThan(12);
      expect(size - line.y).toBeLessThan(12);
    });
  }
});

describe("the pan arrows on the photo, and the watermark kept clear of them", () => {
  const overlap = (a: Rect, b: Rect, gap: number) => a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

  it("none while fitted; only on an axis that can pan; centred on the stage's edges", () => {
    expect(panArrows(PIC, STAGE, FIT)).toEqual({});
    const max = panArrows(PIC, STAGE, { scale: MAX_SCALE, x: 0, y: 0 });
    expect(Object.keys(max).sort()).toEqual(["down", "left", "right", "up"]);
    expect(max.up).toEqual({ x: STAGE.w / 2 - ARROW_PX / 2, y: ARROW_INSET_PX, w: ARROW_PX, h: ARROW_PX });
    expect(max.right).toEqual({ x: STAGE.w - ARROW_INSET_PX - ARROW_PX, y: STAGE.h / 2 - ARROW_PX / 2, w: ARROW_PX, h: ARROW_PX });
    // A wide, short desktop stage: at 1.5x the photo is still narrower than the stage, so only up and down.
    expect(Object.keys(panArrows(PIC, { w: 1280, h: 480 }, { scale: 1.5, x: 0, y: 0 })).sort()).toEqual(["down", "up"]);
  });

  const stages = [
    { w: 320, h: 420 },
    { w: 360, h: 520 },
    { w: 390, h: 560 },
    { w: 412, h: 600 },
    { w: 768, h: 700 },
    { w: 1280, h: 480 },
  ];
  const marks = ["María · 23 Oct 2026", `${"Bartolomé Fernández de la Vega y Ortiz".slice(0, 60)} · 23 Oct 2026`];
  for (const pic of [PIC, PORTRAIT]) {
    for (const stage of stages) {
      it(`${pic.width}×${pic.height} on ${stage.w}×${stage.h}: at every zoom step and pan extreme, the watermark never touches an arrow and stays on the photo`, () => {
        for (const scale of [...ZOOM_LEVELS, 2.37]) {
          for (const [x, y] of [[0, 0], [1e6, 1e6], [-1e6, -1e6], [1e6, -1e6], [-1e6, 1e6]] as const) {
            const view = clampView(pic, stage, { scale, x, y });
            for (const mark of marks) {
              const { ctx, ops } = recorder();
              drawViewer(ctx, pic, stage, 1, view, mark);
              const [line] = texts(ops);
              if (line === undefined) throw new Error("no watermark");
              const box = textBox(line);
              const seen = visible(photoRect(pic, stage, view), stage);
              const where = `${mark.length} chars, scale ${scale}, pan ${x},${y}`;
              expect(inside(box, seen), `${where}: on the photo`).toBe(true);
              for (const [dir, arrow] of Object.entries(panArrows(pic, stage, view))) {
                expect(overlap(box, arrow, ARROW_CLEARANCE_PX - 0.01), `${where}: clear of the ${dir} arrow`).toBe(false);
              }
            }
          }
        }
      });
    }
  }

  it("a short name stays in the corner beside the bottom arrow; a long one on a narrow phone is lifted above it, not squeezed", () => {
    const narrow = { w: 360, h: 520 };
    const max = clampView(PIC, narrow, { scale: MAX_SCALE, x: 0, y: 0 });
    const at = (mark: string) => {
      const r = recorder();
      drawViewer(r.ctx, PIC, narrow, 1, max, mark);
      return texts(r.ops)[0] as Extract<Op, { op: "fillText" }>;
    };
    const short = at("Ana · 23 Oct 2026");
    expect(narrow.h - short.y, "short: still at the corner").toBeLessThan(16);
    const long = at(marks[1] as string);
    const down = panArrows(PIC, narrow, max).down as Rect;
    expect(long.y, "long: above the bottom arrow").toBeLessThanOrEqual(down.y - ARROW_CLEARANCE_PX);
    expect(long.maxWidth ?? 0, "long: given most of the photo's width").toBeGreaterThan(narrow.w * 0.8);
  });

  it("fitted, with no arrows, a long name keeps the corner", () => {
    const r = recorder();
    drawViewer(r.ctx, PIC, { w: 360, h: 520 }, 1, FIT, marks[1] as string);
    const [line] = texts(r.ops);
    const seen = visible(photoRect(PIC, { w: 360, h: 520 }, FIT), { w: 360, h: 520 });
    expect(seen.y + seen.h - (line?.y ?? 0)).toBeLessThan(16);
  });
});

describe("zoom and pan (brief §11)", () => {
  it("fits the photo at scale 1 and cannot pan there", () => {
    const r = photoRect(PIC, STAGE, FIT);
    expect(r.w).toBeCloseTo(STAGE.w);
    expect(canPan(PIC, STAGE, FIT)).toEqual({ up: false, down: false, left: false, right: false });
    expect(panBy(PIC, STAGE, FIT, "left")).toEqual(FIT);
    expect(canZoom(FIT)).toEqual({ in: true, out: false });
  });

  it("stops panning at the photo's edges, on every axis, at every zoom level", () => {
    for (const scale of ZOOM_LEVELS) {
      for (const dir of ["up", "down", "left", "right"] as const) {
        let v: View = { scale, x: 0, y: 0 };
        for (let i = 0; i < 50; i++) v = panBy(PIC, STAGE, v, dir);
        const r = photoRect(PIC, STAGE, v);
        // Where the photo is larger than the stage, it still covers it.
        if (r.w >= STAGE.w) {
          expect(r.x).toBeLessThanOrEqual(1e-6);
          expect(r.x + r.w).toBeGreaterThanOrEqual(STAGE.w - 1e-6);
        }
        if (r.h >= STAGE.h) {
          expect(r.y).toBeLessThanOrEqual(1e-6);
          expect(r.y + r.h).toBeGreaterThanOrEqual(STAGE.h - 1e-6);
        }
        expect(canPan(PIC, STAGE, v)[dir]).toBe(false);
      }
    }
  });

  it("the buttons step through the levels, from anywhere a pinch left them, and stop at the ends", () => {
    let v: View = FIT;
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) seen.push((v = zoomBy(PIC, STAGE, v, 1)).scale);
    expect(seen).toEqual([1.5, 2, 3, 4, 4, 4]);
    expect(canZoom(v)).toEqual({ in: false, out: true });
    expect(zoomBy(PIC, STAGE, { scale: 2.37, x: 0, y: 0 }, 1).scale).toBe(3);
    expect(zoomBy(PIC, STAGE, { scale: 2.37, x: 0, y: 0 }, -1).scale).toBe(2);
    expect(zoomBy(PIC, STAGE, { scale: 1.2, x: 0, y: 0 }, -1).scale).toBe(1);
  });

  it("zooming out re-clamps a pan that no longer fits", () => {
    let v = clampView(PIC, STAGE, { scale: MAX_SCALE, x: 1e6, y: 1e6 });
    for (let i = 0; i < 4; i++) v = zoomBy(PIC, STAGE, v, -1);
    expect(v).toEqual(FIT);
  });

  it("scale is bounded at both ends, whatever a pinch asks for", () => {
    const c = { x: 100, y: 100 };
    expect(moveView(PIC, STAGE, FIT, 0.2, c, c).scale).toBe(1);
    expect(moveView(PIC, STAGE, FIT, 40, c, c).scale).toBe(MAX_SCALE);
    expect(moveView(PIC, STAGE, FIT, Number.NaN, c, c)).toEqual(FIT);
  });

  it("zooming about a point keeps that point of the photo under it", () => {
    // Near the middle, so the photo's edges do not stop it (they would, and should, near a corner).
    const at = { x: 220, y: 280 };
    const before = photoRect(PIC, STAGE, FIT);
    const fx = (at.x - before.x) / before.w;
    const fy = (at.y - before.y) / before.h;
    const v = moveView(PIC, STAGE, FIT, 2, at, at);
    const after = photoRect(PIC, STAGE, v);
    expect(after.x + fx * after.w).toBeCloseTo(at.x);
    expect(after.y + fy * after.h).toBeCloseTo(at.y);
  });

  it("a double tap zooms in about the tapped point from fitted, and returns to fitted from anything else", () => {
    const v = doubleTap(PIC, STAGE, FIT, { x: 50, y: 300 });
    expect(v.scale).toBe(2);
    expect(v.x).toBeGreaterThan(0);
    expect(doubleTap(PIC, STAGE, v, { x: 50, y: 300 })).toEqual(FIT);
    expect(doubleTap(PIC, STAGE, { scale: 1.3, x: 0, y: 0 }, { x: 1, y: 1 })).toEqual(FIT);
  });
});

/*
 * Brief §10 at the source: canvas only. No <img> anywhere in the app, no
 * object URL that could outlive a draw, and no watermark element over a
 * canvas. Checked on the files, because a component test cannot see a tag
 * that was never rendered.
 */
describe("canvas only, in the source", () => {
  const SRC = fileURLToPath(new URL("../..", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const app = files(SRC).filter((f) => /\.(svelte|ts)$/.test(f) && !/\.test(-support)?\.ts$/.test(f));

  it("has no <img>, no object URL, no innerHTML", () => {
    for (const f of app) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/<img\b/i);
      expect(text, f).not.toMatch(/createObjectURL/);
      expect(text, f).not.toMatch(/innerHTML|\{@html/);
    }
    expect(app.length).toBeGreaterThan(10);
  });

  it("never disables the page's own zoom, and takes touch only on the viewer's photo (brief §11)", () => {
    const html = readFileSync(join(SRC, "app.html"), "utf8");
    const viewport = /<meta name="viewport" content="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(viewport).toContain("width=device-width");
    expect(viewport).not.toMatch(/user-scalable\s*=\s*(no|0)|maximum-scale|minimum-scale/i);
    for (const f of app) expect(readFileSync(f, "utf8"), f).not.toMatch(/user-scalable|maximum-scale/i);
    const touch = app.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/touch-action\s*:\s*([a-z-]+)\s*;/g)].map((m) => `${f.slice(SRC.length)}: ${m[1]}`));
    expect(touch).toEqual(["lib/recipient/ui/Viewer.svelte: none"]);
    const viewer = readFileSync(join(SRC, "lib/recipient/ui/Viewer.svelte"), "utf8");
    expect(viewer).toMatch(/\.frame\s*\{[^}]*touch-action:\s*none/);
  });

  it("the zoom and pan buttons stay beside the gestures (brief §11: not everyone can pinch)", () => {
    const viewer = readFileSync(join(SRC, "lib/recipient/ui/Viewer.svelte"), "utf8");
    for (const slot of ["viewer.zoom-in", "viewer.zoom-out", "viewer.fit"]) {
      expect(viewer, slot).toMatch(new RegExp(`<button[^>]*onclick[^>]*>[\\s\\S]{0,600}?t\\["${slot}"\\]`));
    }
    // The pan arrows: one table, every direction labelled from the copy, rendered as buttons on the photo.
    for (const dir of ["up", "down", "left", "right"]) {
      expect(viewer, dir).toMatch(new RegExp(`\\{ dir: "${dir}", label: t\\["viewer\\.pan-${dir}"\\]`));
    }
    expect(viewer).toMatch(/\{#each ARROWS as a[^}]*\}[\s\S]{0,200}<button class="arrow \{a\.dir\}"[^>]*aria-label=\{a\.label\}[^>]*onclick=/);
    // An unavailable control is aria-disabled: a disabled button drops keyboard focus the moment it reaches its limit.
    expect(viewer).not.toMatch(/<button[^>]*\sdisabled[=\s>]/);
  });

  it("the caption is plain text: no {@html}, never drawn, and its field has no UTF-16 maxlength", () => {
    for (const f of app) {
      const text = readFileSync(f, "utf8");
      expect(text, f).not.toMatch(/fillText\([^)]*caption/i);
      // Whatever reaches a draw call is the watermark or nothing: never the caption.
      for (const call of text.matchAll(/draw(Viewer|Cell|Watermark)\(([^;]*)\)/g)) expect(call[2], `${f}: ${call[0]}`).not.toMatch(/caption/i);
      if (/caption/i.test(text) && f.endsWith(".svelte")) expect(text, f).not.toMatch(/maxlength\s*=/i);
    }
  });

  it("puts no watermark text in markup: it reaches the screen only through drawWatermark", () => {
    for (const f of app.filter((f) => f.endsWith(".svelte"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\bwatermark\b[^=]*\}\s*</);
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\b(en|es|t|copy\(\))\.watermark\b|\["watermark"\]|\bwatermarkLine\(/);
    }
  });
});
