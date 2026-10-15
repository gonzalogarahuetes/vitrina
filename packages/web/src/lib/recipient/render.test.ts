import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIT, ZOOM_LEVELS, canPan, clampView, drawCell, drawViewer, panBy, photoRect, zoomBy, type Ctx, type Picture, type Rect, type View } from "./render";

const PIC: Picture = { width: 1600, height: 1200, close: () => undefined };
const PORTRAIT: Picture = { width: 900, height: 1600, close: () => undefined };
const STAGE = { w: 390, h: 520 };

type Op = { op: "drawImage"; rect: Rect } | { op: "fillText"; text: string; x: number; y: number };

/** A context that records what reaches the pixels, in order. */
function recorder(): { ctx: Ctx; ops: Op[] } {
  const ops: Op[] = [];
  const ctx = {
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    roundRect: () => undefined,
    fill: () => undefined,
    measureText: (t: string) => ({ width: t.length * 8 }),
    drawImage: (_: unknown, x: number, y: number, w: number, h: number) => void ops.push({ op: "drawImage", rect: { x, y, w, h } }),
    fillText: (text: string, x: number, y: number) => void ops.push({ op: "fillText", text, x, y }),
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

const LINES = ["Shared with María", "6 Aug 2026"];

describe("the watermark is drawn into the canvas pixels, over the photo", () => {
  const cases: [string, View][] = [
    ["fitted", FIT],
    ["zoomed 4x, centred", { zoom: 4, x: 0, y: 0 }],
    ["zoomed 4x, panned to the top-left edge", clampView(PIC, STAGE, { zoom: 4, x: 1e6, y: 1e6 })],
    ["zoomed 4x, panned to the bottom-right edge", clampView(PIC, STAGE, { zoom: 4, x: -1e6, y: -1e6 })],
    ["zoomed 2x, panned left", clampView(PIC, STAGE, { zoom: 2, x: 1e6, y: 0 })],
  ];
  for (const [what, view] of cases) {
    it(`${what}: after the photo, inside the stage and inside the photo`, () => {
      const { ctx, ops } = recorder();
      drawViewer(ctx, PIC, STAGE, 2, view, LINES);
      const image = ops.findIndex((o) => o.op === "drawImage");
      const texts = ops.flatMap((o, i) => (o.op === "fillText" ? [{ ...o, i }] : []));
      expect(image).toBe(0);
      expect(texts.map((t) => t.text)).toEqual(LINES);
      const r = photoRect(PIC, STAGE, view);
      for (const t of texts) {
        expect(t.i).toBeGreaterThan(image);
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThanOrEqual(STAGE.w);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeLessThanOrEqual(STAGE.h);
        expect(t.x).toBeGreaterThanOrEqual(r.x);
        expect(t.x).toBeLessThanOrEqual(r.x + r.w);
        expect(t.y).toBeGreaterThanOrEqual(r.y);
        expect(t.y).toBeLessThanOrEqual(r.y + r.h);
      }
    });
  }

  it("stays at the same place on screen however the photo is panned", () => {
    const at = (view: View) => {
      const { ctx, ops } = recorder();
      drawViewer(ctx, PIC, STAGE, 1, view, LINES);
      return ops.filter((o) => o.op === "fillText");
    };
    const a = at(clampView(PIC, STAGE, { zoom: 4, x: 1e6, y: 1e6 }));
    const b = at(clampView(PIC, STAGE, { zoom: 4, x: -1e6, y: -1e6 }));
    expect(a).toEqual(b);
  });

  it("thumbnails carry it inside the cell's pixels", () => {
    const { ctx, ops } = recorder();
    drawCell(ctx, PORTRAIT, 180, 2, LINES);
    expect(ops[0]?.op).toBe("drawImage");
    const texts = ops.filter((o) => o.op === "fillText");
    expect(texts.map((t) => (t.op === "fillText" ? t.text : ""))).toEqual(LINES);
    for (const t of texts) if (t.op === "fillText") expect(t.x > 0 && t.x < 180 && t.y > 0 && t.y < 180).toBe(true);
  });
});

describe("zoom and pan (brief §11)", () => {
  it("fits the photo at zoom 1 and cannot pan there", () => {
    const r = photoRect(PIC, STAGE, FIT);
    expect(r.w).toBeCloseTo(STAGE.w);
    expect(canPan(PIC, STAGE, FIT)).toEqual({ up: false, down: false, left: false, right: false });
    expect(panBy(PIC, STAGE, FIT, "left")).toEqual(FIT);
  });

  it("stops panning at the photo's edges, on every axis, at every zoom", () => {
    for (let zoom = 0; zoom < ZOOM_LEVELS.length; zoom++) {
      for (const dir of ["up", "down", "left", "right"] as const) {
        let v: View = { zoom, x: 0, y: 0 };
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

  it("zooming out re-clamps a pan that no longer fits", () => {
    const deep = clampView(PIC, STAGE, { zoom: 4, x: 1e6, y: 1e6 });
    const back = zoomBy(PIC, STAGE, deep, -4);
    expect(back).toEqual({ zoom: 0, x: 0, y: 0 });
  });

  it("zoom is bounded by the levels", () => {
    expect(zoomBy(PIC, STAGE, FIT, -1).zoom).toBe(0);
    expect(zoomBy(PIC, STAGE, { zoom: 4, x: 0, y: 0 }, 1).zoom).toBe(4);
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

  it("puts no watermark text in markup: it reaches the screen only through drawWatermark", () => {
    for (const f of app.filter((f) => f.endsWith(".svelte"))) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\bwatermark\b[^=]*\}\s*</);
      expect(readFileSync(f, "utf8"), f).not.toMatch(/\ben\.watermark|en\["watermark"\]/);
    }
  });
});
