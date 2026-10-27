/*
 * The recipient's viewer in a real browser, on pixels: the production build,
 * the real WASM, and the fake relay (relay.ts). An owner uploads one photo
 * with a caption through the review step and makes a QR invite; a recipient
 * opens it in another context.
 *
 *   1. The watermark (brief §5, §16 "Screenshots leave marks"), read from the
 *      canvas's own pixels: present, in the bottom-right corner of the photo,
 *      never in the letterbox, one short line rather than across the photo.
 *      Fitted, then at maximum zoom panned to each corner and each edge, then
 *      after gestures. And in the grid's thumbnail, in its corner.
 *   2. Gestures, by dispatched Pointer Events: pinch zooms, drag pans and
 *      stops at the edges, double tap zooms in and resets. The buttons are
 *      all still there: one row below the photo, and pan arrows on its edges
 *      only while it can pan, never over the watermark's pixels. Every control
 *      is reached by Tab in visual order, labelled, and keeps focus when it
 *      reaches its limit. Each frame is redrawn into a full-resolution canvas,
 *      never a CSS-scaled one. touch-action is none on the photo only, and the
 *      viewport never disables the page's zoom. Again on a 360 px phone.
 *   3. The caption: plain text below the photo, never markup, never over it;
 *      in no request outside the metadata envelope, and in no storage.
 *
 * The photo is one flat colour, so anything on it that is neither that colour
 * nor the stage's is the watermark, or a caption drawn where it must not be.
 */
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { LANGUAGES } from "../../src/lib/copy/index.ts";
import { autonym } from "../../src/lib/copy/format.ts";
import { storageViolations } from "../storage-allowlist.ts";
import { dumpStorage, watch } from "./helpers.ts";
import { fakeRelay, type Logged } from "./relay.ts";

const EMAIL = "parent@example.com";
const PASSWORD = "copper kettle under the stairs 47";
const ARGON = 60_000;
/** Long enough that, on a phone, the bottom arrow would meet it: the watermark must move clear. */
const LABEL = "María Fernández de la Vega";
const ALBUM_TITLE = "Verano 2026";
const CAPTION = "En la playa con la abuela <i>¡qué ola!</i> & 🌊\nsegunda línea";
/** The photo's colour: mid-tone, so both the white text and its dark shadow differ from it. */
const PHOTO_RGB = [0x6b, 0x8f, 0x5e] as const;
const STAGE_RGB = [0x2a, 0x28, 0x24] as const;

type Relay = ReturnType<typeof fakeRelay>;
type Box = { x: number; y: number; w: number; h: number };
type Scan = {
  /** Device pixels that are neither the photo's colour nor the stage's, away from the photo's own edge. */
  marked: number;
  /** Their bounding box, in CSS pixels. Null when there are none. */
  markBox: Box | null;
  /** The photo as seen on the canvas, in CSS pixels. */
  photoBox: Box | null;
  /** Marked pixels in the letterbox, outside the photo. Must be zero. */
  outside: number;
  /** Stage-coloured pixels: zero when the photo covers the canvas. */
  stage: number;
  cssW: number;
  cssH: number;
};

/** Reads every pixel of `canvas` in the page and classifies it. */
async function scan(page: Page, selector: string, opts: { stage: boolean }): Promise<Scan> {
  return page.locator(selector).evaluate(
    (c: HTMLCanvasElement, [P, S, useStage]) => {
      const ctx = c.getContext("2d", { colorSpace: "srgb" }) as CanvasRenderingContext2D;
      const { width: W, height: H } = c;
      const d = ctx.getImageData(0, 0, W, H).data;
      const k = W / c.clientWidth;
      const near = (i: number, rgb: readonly number[], tol: number) => Math.abs((d[i] ?? 0) - (rgb[0] ?? 0)) + Math.abs((d[i + 1] ?? 0) - (rgb[1] ?? 0)) + Math.abs((d[i + 2] ?? 0) - (rgb[2] ?? 0)) <= tol;
      let px0 = W, py0 = H, px1 = -1, py1 = -1, stage = 0;
      const cls = new Uint8Array(W * H); // 0 photo, 1 stage, 2 other
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          if (near(i, P, 30)) {
            cls[y * W + x] = 0;
            px0 = Math.min(px0, x); py0 = Math.min(py0, y); px1 = Math.max(px1, x); py1 = Math.max(py1, y);
          } else if (useStage && near(i, S, 6)) {
            cls[y * W + x] = 1;
            stage++;
          } else cls[y * W + x] = 2;
        }
      }
      // A band of two CSS pixels on the photo's border is its own anti-aliased edge against the letterbox: neither.
      const edge = 2 * k;
      let marked = 0, outside = 0, mx0 = W, my0 = H, mx1 = -1, my1 = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (cls[y * W + x] !== 2) continue;
          const interior = x > px0 + edge && x < px1 - edge && y > py0 + edge && y < py1 - edge;
          const band = x >= px0 - edge && x <= px1 + edge && y >= py0 - edge && y <= py1 + edge;
          if (interior) {
            marked++;
            mx0 = Math.min(mx0, x); my0 = Math.min(my0, y); mx1 = Math.max(mx1, x); my1 = Math.max(my1, y);
          } else if (!band) outside++;
        }
      }
      const box = (x0: number, y0: number, x1: number, y1: number) => ({ x: x0 / k, y: y0 / k, w: (x1 - x0 + 1) / k, h: (y1 - y0 + 1) / k });
      return {
        marked,
        markBox: marked === 0 ? null : box(mx0, my0, mx1, my1),
        photoBox: px1 < 0 ? null : box(px0, py0, px1, py1),
        outside,
        stage,
        cssW: c.clientWidth,
        cssH: c.clientHeight,
      };
    },
    [PHOTO_RGB, STAGE_RGB, opts.stage] as const,
  );
}

/**
 * The watermark as the product promises it: there, at the photo's right edge,
 * one line, nowhere else; at the bottom corner, or, when the bottom pan arrow
 * would be in its way, just above that arrow (`downArrowTop`, canvas CSS px).
 */
function expectCornerMark(s: Scan, what: string, downArrowTop: number | null = null): void {
  expect(s.outside, `${what}: nothing drawn in the letterbox`).toBe(0);
  expect(s.marked, `${what}: the watermark is in the pixels`).toBeGreaterThan(150);
  const m = s.markBox as Box;
  const p = s.photoBox as Box;
  expect(p, `${what}: the photo is on the canvas`).not.toBeNull();
  expect(p.x + p.w - (m.x + m.w), `${what}: at the photo's right edge`).toBeLessThan(24);
  const atBottom = p.y + p.h - (m.y + m.h) < 24;
  const aboveArrow = downArrowTop !== null && m.y + m.h <= downArrowTop && downArrowTop - (m.y + m.h) < 24;
  expect(atBottom || aboveArrow, `${what}: at the photo's bottom edge, or just above the bottom arrow (mark ${JSON.stringify(m)}, arrow top ${downArrowTop})`).toBe(true);
  expect(m.h, `${what}: one line, not a block`).toBeLessThan(30);
  expect(m.x + m.w / 2, `${what}: right-aligned in the corner, not centred across the photo`).toBeGreaterThan(p.x + p.w / 2 + 2);
  expect(m.x, `${what}: inside the photo`).toBeGreaterThanOrEqual(p.x);
  expect(m.y, `${what}: inside the photo`).toBeGreaterThanOrEqual(p.y);
}

async function flatJpeg(page: Page, w: number, h: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ([w, h, rgb]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { colorSpace: "srgb" }) as CanvasRenderingContext2D;
      ctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      ctx.fillRect(0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.95));
      return Array.from(new Uint8Array(await (blob as Blob).arrayBuffer()));
    },
    [w, h, PHOTO_RGB] as const,
  );
  return Buffer.from(bytes);
}

/** An owner with one captioned photo at ready and a QR invite: returns the link. */
async function ownerShares(browser: Browser, relay: Relay) {
  const ctx = await browser.newContext();
  await relay.attach(ctx);
  const page = await ctx.newPage();
  const violations = await watch(page);
  await page.goto("/");
  await page.getByRole("button", { name: en["signin.to-signup"] }).click();
  await page.getByLabel(en["signup.email.label"]).fill(EMAIL);
  await page.getByLabel(en["signup.password.label"]).fill(PASSWORD);
  await page.getByRole("button", { name: en["signup.submit"] }).click();
  await expect(page.getByRole("heading", { name: en["albums.title"], exact: true })).toBeVisible({ timeout: ARGON });
  await page.getByRole("button", { name: en["album.create"] }).click();
  await page.getByLabel(en["album.title.label"]).fill(ALBUM_TITLE);
  await page.getByRole("button", { name: en["album.create.submit"] }).click();
  await page.getByRole("button", { name: en["albums.open.a11y"](ALBUM_TITLE) }).click();
  await expect(page.getByRole("heading", { name: ALBUM_TITLE, exact: true })).toBeVisible();

  const before = relay.log.length;
  await page.locator("#add-photos").setInputFiles([{ name: "playa.jpg", mimeType: "image/jpeg", buffer: await flatJpeg(page, 1200, 900) }]);
  const review = page.getByRole("dialog", { name: en["upload.review.title"](1) });
  await expect(review.locator('li[data-preview="ready"]')).toHaveCount(1, { timeout: 30_000 });
  await review.getByLabel(en["upload.review.caption.label"]).fill(CAPTION);
  expect(relay.log.length, "no request while the review is open").toBe(before);
  await review.getByRole("button", { name: en["upload.review.send"](1) }).click();
  await expect(page.getByRole("button", { name: en["album.photo.a11y"](1, 1) })).toBeVisible({ timeout: 60_000 });

  await page.getByRole("button", { name: en["album.invite"] }).click();
  await page.getByLabel(en["invite.name.label"]).fill(LABEL);
  await page.getByRole("button", { name: en["invite.create"] }).click();
  await expect(page.getByRole("heading", { name: en["invite.share.title"](LABEL) })).toBeVisible({ timeout: ARGON });
  const link = (await page.locator("[data-invite-link]").textContent()) ?? "";
  return { ctx, page, violations, link };
}

/**
 * Dispatches Pointer Events on the viewer's photo frame. Positions are CSS
 * pixels from the frame's top-left; ["wait", ms] pauses between events.
 */
type Step = readonly ["pointerdown" | "pointermove" | "pointerup", number, number, number] | readonly ["wait", number];
async function gesture(page: Page, steps: readonly Step[]): Promise<void> {
  await page.locator(".viewer .frame").evaluate(async (f: HTMLElement, steps) => {
    const r = f.getBoundingClientRect();
    for (const s of steps) {
      if (s[0] === "wait") {
        await new Promise((res) => setTimeout(res, s[1]));
        continue;
      }
      const [type, id, x, y] = s;
      f.dispatchEvent(
        new PointerEvent(type, {
          pointerId: id,
          pointerType: "touch",
          isPrimary: id === 1,
          clientX: r.left + x,
          clientY: r.top + y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
  }, steps);
}

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** Unavailable controls are aria-disabled, so they keep focus: read that, not the disabled property. */
const off = (l: Locator, message?: string) => expect(l, message).toHaveAttribute("aria-disabled", "true");
async function on(l: Locator, message?: string, timeout?: number): Promise<void> {
  const t = timeout === undefined ? {} : { timeout };
  await expect(l, message).toBeVisible(t);
  await expect(l, message).not.toHaveAttribute("aria-disabled", "true", t);
}

async function pressWhileEnabled(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 40 && (await button(page, name).getAttribute("aria-disabled")) !== "true"; i++) await button(page, name).click();
  await off(button(page, name));
}

type PageBox = { x: number; y: number; width: number; height: number };
const meets = (a: PageBox, b: PageBox) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Scans the viewer's pixels and checks the watermark against the arrows as
 * they are on the page: in its place, and not under any arrow's box.
 */
async function checkMark(page: Page, what: string): Promise<Scan> {
  const s = await scan(page, ".viewer canvas", { stage: true });
  const canvas = (await page.locator(".viewer canvas").boundingBox()) as PageBox;
  // No arrows while fitted: boundingBox() would wait for one rather than answer null, so count first.
  const downs = page.locator(".viewer .arrow.down");
  const down = (await downs.count()) > 0 ? await downs.boundingBox() : null;
  expectCornerMark(s, what, down === null ? null : down.y - canvas.y);
  const m = s.markBox as Box;
  const mark = { x: canvas.x + m.x, y: canvas.y + m.y, width: m.w, height: m.h };
  for (const a of await page.locator(".viewer .arrow").all()) {
    const b = (await a.boundingBox()) as PageBox;
    expect(meets(mark, b), `${what}: the ${await a.getAttribute("aria-label")} arrow is clear of the watermark`).toBe(false);
  }
  return s;
}

/** The canvas is redrawn at full resolution, not stretched by CSS. */
async function expectFullResolution(page: Page): Promise<void> {
  const c = await page.locator(".viewer canvas").evaluate((c: HTMLCanvasElement) => ({
    w: c.width,
    cw: c.clientWidth,
    dpr: window.devicePixelRatio || 1,
    transform: getComputedStyle(c).transform,
    frame: getComputedStyle(c.parentElement as HTMLElement).transform,
  }));
  expect(c.w).toBe(Math.round(c.cw * c.dpr));
  expect(c.transform).toBe("none");
  expect(c.frame).toBe("none");
}

function captionSpellings(c: string): string[] {
  const utf8 = Buffer.from(c, "utf8");
  return [c, c.split("\n")[0] as string, "abuela", JSON.stringify(c).slice(1, -1), encodeURIComponent(c), utf8.toString("latin1"), utf8.toString("base64").slice(0, 16), utf8.toString("base64url").slice(0, 16)];
}

function assertNoCaption(log: readonly Logged[]): void {
  expect(log.length).toBeGreaterThan(0);
  for (const r of log) {
    const where = [r.path, r.search, r.hash, r.body, ...Object.values(r.headers), r.bytes?.toString("latin1") ?? ""];
    for (const s of captionSpellings(CAPTION)) for (const w of where) expect(w, `caption in ${r.method} ${r.path}`).not.toContain(s);
  }
}

test("the viewer: the watermark in the photo's corner at every zoom and pan, gestures beside the buttons, and the caption below as text", async ({ browser, browserName }) => {
  test.setTimeout(300_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const owner = await ownerShares(browser, relay);

  const ctx = await browser.newContext();
  await relay.attach(ctx);
  const page = await ctx.newPage();
  const violations = await watch(page);
  await page.goto(owner.link);
  await page.getByRole("button", { name: en["onboarding.continue"] }).click();
  const cell = page.getByRole("button", { name: en["grid.photo.a11y"](1, 1) });
  await expect(cell).toBeVisible({ timeout: 30_000 });

  // ── The grid's thumbnail carries it, in its corner ───────────────────────
  await expect.poll(async () => (await scan(page, ".cells canvas", { stage: false })).marked, { timeout: 10_000 }).toBeGreaterThan(40);
  {
    const s = await scan(page, ".cells canvas", { stage: false });
    expect(s.outside).toBe(0);
    const m = s.markBox as Box;
    expect(s.cssW - (m.x + m.w), "thumbnail: at the right edge").toBeLessThan(16);
    expect(s.cssH - (m.y + m.h), "thumbnail: at the bottom edge").toBeLessThan(16);
    expect(m.h, "thumbnail: one line").toBeLessThan(24);
  }

  // ── The viewer ───────────────────────────────────────────────────────────
  await cell.click();
  await on(button(page, en["viewer.zoom-in"]), undefined, 30_000);
  const fitted = await scan(page, ".viewer canvas", { stage: true });
  expect(fitted.stage, "fitted, the letterbox shows").toBeGreaterThan(0);
  expectCornerMark(fitted, "fitted");
  await expect(page.locator(".viewer .arrow"), "no pan arrows while fitted: nothing to pan").toHaveCount(0);
  // One row below the photo, at the target height.
  const row = await Promise.all([en["viewer.zoom-out"], en["viewer.fit"], en["viewer.zoom-in"]].map(async (n) => (await button(page, n).boundingBox()) as PageBox));
  expect(new Set(row.map((b) => Math.round(b.y))).size, "Zoom out · Fit · Zoom in on one row").toBe(1);
  for (const b of row) expect(b.height).toBeGreaterThanOrEqual(60);

  // Touch is taken on the photo only; the page's own zoom is never disabled (brief §11).
  const touch = await page.evaluate(() => ({
    frame: getComputedStyle(document.querySelector(".viewer .frame") as Element).touchAction,
    controls: getComputedStyle(document.querySelector(".viewer .controls") as Element).touchAction,
    root: getComputedStyle(document.documentElement).touchAction,
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
  }));
  expect(touch.frame).toBe("none");
  expect(touch.controls).toBe("auto");
  expect(touch.root).toBe("auto");
  expect(touch.viewport).not.toMatch(/user-scalable|maximum-scale/i);

  // ── The caption: text, below the photo, never markup ─────────────────────
  const caption = page.locator("#viewer-caption");
  await expect(caption).toHaveText(CAPTION, { useInnerText: true });
  expect(await caption.locator("i").count(), "plain text, never markup").toBe(0);
  const [frameBox, captionBox] = await Promise.all([page.locator(".viewer .frame").boundingBox(), caption.boundingBox()]);
  expect((captionBox?.y ?? 0) >= (frameBox?.y ?? 0) + (frameBox?.height ?? 0) - 0.5, "below the photo").toBe(true);
  await expect(page.locator(".viewer .frame")).toHaveAttribute("aria-describedby", "viewer-caption");

  // ── Maximum zoom by the buttons, panned to every corner and edge ─────────
  await pressWhileEnabled(page, en["viewer.zoom-in"]);
  const corners: [string, string[]][] = [
    ["top-left", [en["viewer.pan-left"], en["viewer.pan-up"]]],
    ["top-right", [en["viewer.pan-right"], en["viewer.pan-up"]]],
    ["bottom-right", [en["viewer.pan-right"], en["viewer.pan-down"]]],
    ["bottom-left", [en["viewer.pan-left"], en["viewer.pan-down"]]],
  ];
  // Centred on the photo's edges, at the target size.
  {
    const canvas = (await page.locator(".viewer canvas").boundingBox()) as PageBox;
    const up = (await button(page, en["viewer.pan-up"]).boundingBox()) as PageBox;
    const right = (await button(page, en["viewer.pan-right"]).boundingBox()) as PageBox;
    expect(Math.abs(up.x + up.width / 2 - (canvas.x + canvas.width / 2))).toBeLessThan(1.5);
    expect(Math.abs(right.y + right.height / 2 - (canvas.y + canvas.height / 2))).toBeLessThan(1.5);
    expect([up.width, up.height, right.width, right.height].every((d) => Math.abs(d - 60) < 1)).toBe(true);
  }
  for (const [where, presses] of corners) {
    for (const p of presses) await pressWhileEnabled(page, p);
    const s = await checkMark(page, `max zoom, ${where}`);
    expect(s.stage, `max zoom, ${where}: the photo covers the stage`).toBe(0);
  }
  // Each edge, from the middle of the other axis.
  for (const [where, p] of [
    ["left edge", en["viewer.pan-left"]],
    ["right edge", en["viewer.pan-right"]],
    ["top edge", en["viewer.pan-up"]],
    ["bottom edge", en["viewer.pan-down"]],
  ] as const) {
    await button(page, en["viewer.fit"]).click();
    await pressWhileEnabled(page, en["viewer.zoom-in"]);
    await pressWhileEnabled(page, p);
    await checkMark(page, `max zoom, ${where}`);
  }
  await expectFullResolution(page);

  // ── Gestures, by dispatched Pointer Events ───────────────────────────────
  await button(page, en["viewer.fit"]).click();
  await off(button(page, en["viewer.zoom-out"]));
  const box = (await page.locator(".viewer .frame").boundingBox()) as { width: number; height: number };
  const cx = box.width / 2;
  const cy = box.height / 2;

  // Pinch out: two fingers apart from the middle, 60 px to 220 px, about 3.7×. That much
  // because on the desktop project the stage is wide and short: the fitted photo is much
  // narrower than the stage and needs a large zoom before it can pan sideways at all.
  await gesture(page, [
    ["pointerdown", 1, cx - 30, cy],
    ["pointerdown", 2, cx + 30, cy],
    ["pointermove", 1, cx - 60, cy],
    ["pointermove", 2, cx + 60, cy],
    ["pointermove", 1, cx - 110, cy],
    ["pointermove", 2, cx + 110, cy],
    ["pointerup", 1, cx - 110, cy],
    ["pointerup", 2, cx + 110, cy],
  ]);
  await on(button(page, en["viewer.zoom-out"]), "the pinch zoomed in");
  await on(button(page, en["viewer.fit"]));
  await on(button(page, en["viewer.zoom-in"]), "short of the maximum");
  await expectFullResolution(page);
  await checkMark(page, "after a pinch");
  // Both axes can pan before the drag, so "stopped at the edge" below is a real stop and not
  // an axis that never moved.
  for (const name of [en["viewer.pan-left"], en["viewer.pan-right"], en["viewer.pan-up"], en["viewer.pan-down"]]) {
    await on(button(page, name), `${name}: pannable after the pinch`);
  }

  // Drag far right and down: the photo stops at its left and top edges.
  await gesture(page, [
    ["pointerdown", 3, cx, cy],
    ["pointermove", 3, cx + 400, cy + 400],
    ["pointermove", 3, cx + 2000, cy + 2000],
    ["pointerup", 3, cx + 2000, cy + 2000],
  ]);
  await off(button(page, en["viewer.pan-left"]), "stopped at the left edge");
  await off(button(page, en["viewer.pan-up"]), "stopped at the top edge");
  await on(button(page, en["viewer.pan-right"]));
  await on(button(page, en["viewer.pan-down"]));
  await checkMark(page, "after a drag to the edge");

  // Pinch far past the maximum: it stops there.
  await gesture(page, [
    ["pointerdown", 4, cx - 10, cy],
    ["pointerdown", 5, cx + 10, cy],
    ["pointermove", 4, cx - 600, cy],
    ["pointermove", 5, cx + 600, cy],
    ["pointerup", 4, cx - 600, cy],
    ["pointerup", 5, cx + 600, cy],
  ]);
  await off(button(page, en["viewer.zoom-in"]), "at the maximum");
  await checkMark(page, "pinched to the maximum");

  // Double tap: zoomed, so back to fitted; again, and it zooms in.
  const tap = (id: number): Step[] => [
    ["pointerdown", id, cx + 20, cy + 10],
    ["pointerup", id, cx + 20, cy + 10],
  ];
  await gesture(page, [...tap(6), ["wait", 60], ...tap(7)]);
  await off(button(page, en["viewer.zoom-out"]), "double tap: back to fitted");
  await gesture(page, [...tap(8), ["wait", 60], ...tap(9)]);
  await on(button(page, en["viewer.zoom-out"]), "double tap: zoomed in");
  await checkMark(page, "after a double tap");

  // ── Keyboard: every control, labelled, in visual order; focus kept at a limit ──
  await button(page, en["viewer.fit"]).click();
  await pressWhileEnabled(page, en["viewer.zoom-in"]);
  // The language switcher sits in the viewer's top row after Back, offering the languages not in use (brief §15: on every screen).
  const visualOrder = [en["viewer.back"], ...LANGUAGES.filter((l) => l !== "en").map(autonym), en["viewer.pan-up"], en["viewer.pan-left"], en["viewer.pan-right"], en["viewer.pan-down"], en["viewer.zoom-out"], en["viewer.fit"], en["viewer.zoom-in"]];
  const named = await page.locator(".viewer button").evaluateAll((bs) =>
    bs.map((b) => ({ name: b.getAttribute("aria-label") ?? b.textContent?.trim() ?? "", tabindex: b.getAttribute("tabindex"), disabled: (b as HTMLButtonElement).disabled })),
  );
  expect(named.map((b) => b.name), "every control a labelled button, in visual order").toEqual(visualOrder);
  expect(named.filter((b) => b.disabled || b.tabindex === "-1"), "none taken out of the tab order").toEqual([]);
  // Safari does not move focus to buttons with Tab by default; the walk itself is checked in Chromium.
  if (browserName === "chromium") {
    await button(page, en["viewer.back"]).focus();
    const walked: string[] = [];
    for (let i = 1; i < visualOrder.length; i++) {
      await page.keyboard.press("Tab");
      walked.push(await page.evaluate(() => (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "").trim()));
    }
    expect(walked, "Tab reaches every control, in visual order").toEqual(visualOrder.slice(1));
  }
  await button(page, en["viewer.fit"]).click();
  await button(page, en["viewer.zoom-in"]).focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press("Enter");
  await off(button(page, en["viewer.zoom-in"]), "Enter zoomed to the maximum");
  await expect(button(page, en["viewer.zoom-in"]), "focus kept at the limit").toBeFocused();
  // By keyboard: Safari does not focus a button that is clicked, so a click would prove nothing about focus there.
  await button(page, en["viewer.pan-left"]).focus();
  for (let i = 0; i < 40 && (await button(page, en["viewer.pan-left"]).getAttribute("aria-disabled")) !== "true"; i++) await page.keyboard.press("Enter");
  await off(button(page, en["viewer.pan-left"]), "Enter panned to the photo's left edge");
  await expect(button(page, en["viewer.pan-left"]), "focus kept on an arrow at the photo's edge").toBeFocused();

  // ── A 360 px phone: the bottom arrow is where a long name would be ───────
  await page.setViewportSize({ width: 360, height: 740 });
  await button(page, en["viewer.fit"]).click();
  await pressWhileEnabled(page, en["viewer.zoom-in"]);
  await checkMark(page, "360 px phone, max zoom, centred");
  for (const p of [en["viewer.pan-right"], en["viewer.pan-down"]]) await pressWhileEnabled(page, p);
  await checkMark(page, "360 px phone, max zoom, bottom-right corner");
  await button(page, en["viewer.fit"]).click();
  await checkMark(page, "360 px phone, fitted");

  // The buttons stay, all of them (brief §11: not everyone can pinch); the arrows whenever the photo can pan.
  await pressWhileEnabled(page, en["viewer.zoom-in"]);
  for (const name of [en["viewer.zoom-in"], en["viewer.zoom-out"], en["viewer.fit"], en["viewer.pan-up"], en["viewer.pan-down"], en["viewer.pan-left"], en["viewer.pan-right"]]) {
    await expect(button(page, name)).toBeVisible();
  }

  // ── The caption went nowhere but the envelope ────────────────────────────
  assertNoCaption(relay.log);
  expect(storageViolations(await dumpStorage(owner.page), captionSpellings(CAPTION), { owner: true }), "owner storage").toEqual([]);
  const link = owner.link;
  expect(storageViolations(await dumpStorage(page), captionSpellings(CAPTION), { recipientInvite: link.slice(link.indexOf("#")) }), "recipient storage").toEqual([]);
  expect(await owner.violations(), "owner: CSP violations and page errors").toEqual([]);
  expect(await violations(), "recipient: CSP violations and page errors").toEqual([]);
  await ctx.close();
  await owner.ctx.close();
});

// ── The checks, shown to catch what they exist for ─────────────────────────

test("the pixel scan notices a watermark in the letterbox, across the photo, or missing", async ({ page }) => {
  await page.setContent(`<canvas id="c" style="width:390px;height:520px"></canvas>`);
  const draw = (mark: "corner" | "margin" | "across" | "none") =>
    page.evaluate(
      ([mark, P, S]) => {
        const c = document.getElementById("c") as HTMLCanvasElement;
        c.width = 390;
        c.height = 520;
        const ctx = c.getContext("2d", { colorSpace: "srgb" }) as CanvasRenderingContext2D;
        ctx.fillStyle = `rgb(${S.join(",")})`;
        ctx.fillRect(0, 0, 390, 520);
        ctx.fillStyle = `rgb(${P.join(",")})`;
        ctx.fillRect(0, 114, 390, 292);
        ctx.font = "700 15px sans-serif";
        ctx.fillStyle = "rgba(255,255,255,0.78)";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        if (mark === "corner") ctx.fillText("María · 6 Aug 2026", 381, 397);
        if (mark === "margin") ctx.fillText("María · 6 Aug 2026", 381, 500);
        if (mark === "across") {
          ctx.textAlign = "center";
          ctx.font = "700 40px sans-serif";
          ctx.fillText("Shared with María · 6 Aug 2026", 195, 300);
        }
      },
      [mark, PHOTO_RGB, STAGE_RGB] as const,
    );
  await draw("corner");
  expectCornerMark(await scan(page, "#c", { stage: true }), "corner");
  for (const bad of ["margin", "across", "none"] as const) {
    await draw(bad);
    const s = await scan(page, "#c", { stage: true });
    expect(() => expectCornerMark(s, bad), bad).toThrow();
  }
});

test("the arrow check notices an arrow over the watermark", async ({ page }) => {
  await page.setContent(
    `<div class="viewer" style="position:relative;width:390px;height:520px"><canvas style="width:390px;height:520px"></canvas>` +
      `<button class="arrow down" aria-label="Move down" style="position:absolute;width:60px;height:60px;left:300px;top:452px"></button></div>`,
  );
  await page.evaluate(
    ([P]) => {
      const c = document.querySelector("canvas") as HTMLCanvasElement;
      c.width = 390;
      c.height = 520;
      const ctx = c.getContext("2d", { colorSpace: "srgb" }) as CanvasRenderingContext2D;
      ctx.fillStyle = `rgb(${P.join(",")})`;
      ctx.fillRect(0, 0, 390, 520);
      ctx.font = "700 15px sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.78)";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      ctx.fillText("María · 6 Aug 2026", 381, 511);
    },
    [PHOTO_RGB] as const,
  );
  await expect(checkMark(page, "an arrow over the corner")).rejects.toThrow(/clear of the watermark/);
});

test("the caption audit notices the caption in a request", () => {
  const leak: Logged[] = [{ method: "PUT", path: "/v1/media/x/asset", search: "", hash: "", body: "", headers: { "x-note": encodeURIComponent(CAPTION) } }];
  expect(() => assertNoCaption(leak)).toThrow(/caption in PUT/);
});
