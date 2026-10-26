/*
 * The owner's album, upload and removal in a real browser: the production
 * build, the real WASM, the browser's own decoder and canvas encoder, and the
 * fake relay (relay.ts), which stores the ciphertext and hands it back.
 *
 * The photos are phone-shaped: a JPEG this browser encoded, with a camera's
 * APP1 spliced in after SOI — EXIF orientation and a GPS IFD. One is stored
 * landscape with orientation 6, as a phone stores a portrait, and is larger
 * than 1600 px, so the downscaled-decode path runs.
 *
 *   1. One walk: open an album, choose two photos, see the review (canvas
 *      previews, no request while it is open), caption one, send, see each
 *      move through its states to the server's ready, see the thumbnails
 *      drawn the right way up, open the full photo with its caption below it,
 *      remove one (202, then 204 on the retry).
 *   2. Every request: no filename and no caption in any path, query, header or body; uploads
 *      are octet-stream envelopes; the thumbnail is one chunk; the create's
 *      id is the PUTs' id; no full asset before the viewer.
 *   3. Storage at the end, the filenames and the caption added to the secrets.
 *   4. No CSP violation and no uncaught error.
 *   5. A lost create response: the resend meets 409 and goes on with the same id.
 *   6. Ready only on the server's word: held as processing, the item waits.
 *
 * Then the guards, broken on purpose: a canvas that answers PNG, a canvas that
 * reports a colour space other than sRGB, and a canvas JPEG with EXIF hidden
 * in its image data (the scan's job): none may reach the relay. And a canvas JPEG with an added APP1 (the filter's job): it must
 * come out without it and reach ready.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { exifApp1, HIDDEN_EXIF, spliceAfterSoi } from "../../src/lib/owner/jpeg.test-support.ts";
import { storageViolations } from "../storage-allowlist.ts";
import { dumpStorage, watch } from "./helpers.ts";
import { fakeRelay, type Logged } from "./relay.ts";

const EMAIL = "parent@example.com";
const PASSWORD = "copper kettle under the stairs 47";
const ARGON = 60_000;
const ANDROID = "IMG_20260612_bathtime.jpg";
const IPHONE = "IMG_4821 school gate.JPG";
const CHUNK = 262144;
/** Tags, an ampersand, an emoji and a second line: shown literally, as text, or the test fails. */
const CAPTION = "Bañera con la abuela <b>¡sí!</b> & 🛁\nsegunda línea";

type Relay = ReturnType<typeof fakeRelay>;

/** Every spelling of a caption that could leak: as typed, JSON-escaped, URL-encoded, as UTF-8 bytes, base64. */
function captionSpellings(c: string): string[] {
  const utf8 = Buffer.from(c, "utf8");
  return [c, c.split("\n")[0] as string, "abuela", JSON.stringify(c).slice(1, -1), encodeURIComponent(c), utf8.toString("latin1"), utf8.toString("base64").slice(0, 16), utf8.toString("base64url").slice(0, 16)];
}

function assertNoCaption(log: readonly Logged[], caption: string): void {
  for (const r of log) {
    const where = [r.path, r.search, r.hash, r.body, ...Object.values(r.headers), r.bytes?.toString("latin1") ?? ""];
    for (const s of captionSpellings(caption)) for (const w of where) expect(w, `caption in ${r.method} ${r.path}`).not.toContain(s);
  }
}

/** Every spelling of a filename that could leak. */
function spellings(name: string): string[] {
  const stem = name.replace(/\.[^.]+$/, "");
  return [name, encodeURIComponent(name), name.toLowerCase(), stem, Buffer.from(name).toString("base64").slice(0, 12), Buffer.from(name).toString("base64url").slice(0, 12)];
}

function assertNoFilenames(log: readonly Logged[], names: readonly string[]): void {
  expect(log.length).toBeGreaterThan(0);
  for (const r of log) {
    const where = [r.path, r.search, r.hash, r.body, ...Object.values(r.headers), r.bytes?.toString("latin1") ?? ""];
    for (const name of names) for (const s of spellings(name)) for (const w of where) expect(w, `filename in ${r.method} ${r.path}`).not.toContain(s);
  }
}

/** A JPEG this browser encodes: `w`×`h`, red where x < w/3, blue elsewhere. */
async function canvasJpeg(page: Page, w: number, h: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { colorSpace: "srgb" }) as CanvasRenderingContext2D;
      ctx.fillStyle = "#0000ff";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, Math.round(w / 3), h);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.9));
      return Array.from(new Uint8Array(await (blob as Blob).arrayBuffer()));
    },
    [w, h] as const,
  );
  return Buffer.from(bytes);
}

/** As a phone writes it: the camera's APP1 (orientation, GPS) straight after SOI. */
async function phonePhoto(page: Page, w: number, h: number, orientation: number): Promise<Buffer> {
  return Buffer.from(spliceAfterSoi(await canvasJpeg(page, w, h), exifApp1(orientation)));
}

async function signedUpInAlbum(browser: Browser, relay: Relay) {
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
  await page.getByLabel(en["album.title.label"]).fill("Verano 2026");
  await page.getByRole("button", { name: en["album.create.submit"] }).click();
  await page.getByRole("button", { name: en["albums.open.a11y"]("Verano 2026") }).click();
  await expect(page.getByRole("heading", { name: "Verano 2026", exact: true })).toBeVisible();
  await expect(page.getByText(en["album.empty"])).toBeVisible();
  return { ctx, page, violations };
}

/**
 * Choose files, then the review (flows §3.6): a preview per photo, drawn to
 * canvas, no request at all while it is open, optional captions, then Send.
 */
async function add(page: Page, files: { name: string; buffer: Buffer }[], opts: { relay?: Relay; captions?: string[] } = {}): Promise<void> {
  const before = opts.relay?.log.length;
  await page.locator("#add-photos").setInputFiles(files.map((f) => ({ ...f, mimeType: "image/jpeg" })));
  const review = page.getByRole("dialog", { name: en["upload.review.title"](files.length) });
  await expect(review).toBeVisible();
  await expect(review.locator('li[data-preview="ready"], li[data-preview="failed"]')).toHaveCount(files.length, { timeout: 30_000 });
  expect(await review.locator("img").count(), "previews are canvas, never an image element").toBe(0);
  for (const [i, c] of (opts.captions ?? []).entries()) await review.locator("li").nth(i).getByLabel(en["upload.review.caption.label"]).fill(c);
  if (opts.relay !== undefined) expect(opts.relay.log.length, "no request while the review is open").toBe(before);
  await review.getByRole("button", { name: en["upload.review.send"](files.length) }).click();
  await expect(review).toHaveCount(0);
}

const cells = (page: Page) => page.locator("li.cell");
const mediaRoutes = (relay: Relay) => relay.log.filter((r) => r.path.includes("/media"));

/** The cell's canvas, sampled at (x, y) as fractions: "red", "blue" or "other". */
async function colourAt(page: Page, index: number, x: number, y: number): Promise<string> {
  return cells(page)
    .nth(index)
    .locator("canvas")
    .evaluate(
      (c: HTMLCanvasElement, [x, y]) => {
        const ctx = c.getContext("2d", { colorSpace: "srgb" }) as CanvasRenderingContext2D;
        const [r = 0, g = 0, b = 0] = ctx.getImageData(Math.floor(c.width * x), Math.floor(c.height * y), 1, 1).data;
        return r > 180 && g < 90 && b < 90 ? "red" : b > 180 && r < 90 && g < 90 ? "blue" : `other(${r},${g},${b})`;
      },
      [x, y] as const,
    );
}

test("the owner's album: add a portrait and a landscape phone photo, see them reach ready the right way up, view one, remove one", async ({ browser }) => {
  test.setTimeout(240_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { ctx, page, violations } = await signedUpInAlbum(browser, relay);

  // Stored 2400×1600 with orientation 6: shown 1600×2400, red across the top third.
  const portrait = await phonePhoto(page, 2400, 1600, 6);
  // Stored and shown 2000×1500, GPS and all.
  const landscape = await phonePhoto(page, 2000, 1500, 1);
  const before = relay.log.length;

  // ── The review: a wrong photo taken out, then nothing was ever sent for it ──
  await page.locator("#add-photos").setInputFiles([{ name: "wrong.jpg", mimeType: "image/jpeg", buffer: landscape }]);
  await page.getByRole("button", { name: en["upload.review.remove.a11y"]("wrong.jpg") }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(relay.log.length, "nothing sent for a photo taken out").toBe(before);

  // ── The caption field: counted in code points, refused past 280 ─────────
  await page.locator("#add-photos").setInputFiles([{ name: "long.jpg", mimeType: "image/jpeg", buffer: landscape }]);
  const field = page.getByRole("dialog").getByLabel(en["upload.review.caption.label"]);
  await field.fill("🛁".repeat(281));
  await expect(page.getByText(en["upload.review.caption.too-long"])).toBeVisible();
  await expect(page.getByRole("button", { name: en["upload.review.send"](1) })).toBeDisabled();
  await field.fill("🛁".repeat(280));
  expect(await field.inputValue(), "no maxlength cut it short: 280 emoji are 560 UTF-16 units").toHaveLength(560);
  await expect(page.getByText(en["upload.review.caption.count"](280))).toBeVisible();
  await expect(page.getByRole("button", { name: en["upload.review.send"](1) })).toBeEnabled();
  await page.getByRole("button", { name: en["upload.review.cancel"] }).click();
  expect(relay.log.length, "nothing sent on cancel").toBe(before);

  await add(
    page,
    [
      { name: IPHONE, buffer: portrait },
      { name: ANDROID, buffer: landscape },
    ],
    { relay, captions: [CAPTION] },
  );

  await expect(cells(page)).toHaveCount(2);
  await expect(cells(page).locator("canvas")).toHaveCount(2, { timeout: 60_000 });
  await expect(cells(page).nth(0)).toHaveAttribute("data-state", "ready");
  await expect(cells(page).nth(1)).toHaveAttribute("data-state", "ready");

  // Oriented before stripping: the portrait's red third is at the top, not the left (encryption spec §7).
  await expect.poll(() => colourAt(page, 0, 0.5, 0.08)).toBe("red");
  expect(await colourAt(page, 0, 0.5, 0.92)).toBe("blue");
  expect(await colourAt(page, 1, 0.08, 0.5)).toBe("red");
  expect(await colourAt(page, 1, 0.92, 0.5)).toBe("blue");

  // ── What was sent ───────────────────────────────────────────────────────
  const sent = relay.log.slice(before);
  const ids = [...relay.media.keys()];
  expect(ids).toHaveLength(2);
  for (const id of ids) {
    const mine = sent.filter((r) => r.path.includes(id) || (r.method === "POST" && r.body.includes(id)));
    expect(mine.slice(0, 3).map((r) => `${r.method} ${r.path.replace(id, "{id}")}`)).toEqual([
      expect.stringMatching(/^POST \/v1\/albums\/[0-9a-f-]{36}\/media$/),
      "PUT /v1/media/{id}/asset",
      "PUT /v1/media/{id}/thumbnail",
    ]);
    for (const put of mine.filter((r) => r.method === "PUT")) {
      expect(put.headers["content-type"]).toBe("application/octet-stream");
      if (put.headers["content-length"] !== undefined) expect(Number(put.headers["content-length"])).toBe(put.bytes?.length);
      expect(put.bytes?.subarray(0, 4).toString("latin1"), "an envelope, never the original file").toBe("VTRN");
    }
    const thumb = relay.media.get(id)?.thumbnail;
    expect(thumb?.length ?? Infinity, "the thumbnail is one chunk (api-sketch §11.3)").toBeLessThanOrEqual(64 + CHUNK + 16);
    const asset = relay.media.get(id)?.asset;
    expect(asset?.equals(portrait) || asset?.equals(landscape)).toBe(false);
  }
  expect(sent.some((r) => r.path.endsWith("/asset") && r.method === "GET"), "no full asset before the viewer").toBe(false);

  // ── The viewer: the full photo, fetched now and only now, its caption as text below it ──
  await cells(page).nth(0).getByRole("button", { name: en["album.photo.a11y"](1, 2) }).click();
  // Shown: Zoom in becomes available (an unavailable control is aria-disabled, not disabled).
  await expect(page.getByRole("button", { name: en["viewer.zoom-in"] })).toBeVisible();
  await expect(page.getByRole("button", { name: en["viewer.zoom-in"] })).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  const caption = page.locator("#viewer-caption");
  await expect(caption).toHaveText(CAPTION, { useInnerText: true });
  expect(await caption.locator("b").count(), "plain text, never markup").toBe(0);
  const [frameBox, captionBox] = await Promise.all([page.locator(".viewer .frame").boundingBox(), caption.boundingBox()]);
  expect((captionBox?.y ?? 0) >= (frameBox?.y ?? 0) + (frameBox?.height ?? 0) - 0.5, "below the photo, never over it").toBe(true);
  const assetGets = relay.log.filter((r) => r.method === "GET" && r.path.endsWith("/asset"));
  expect(assetGets.map((r) => r.headers["range"])).toEqual(["bytes=0-"]);
  await page.getByRole("button", { name: en["viewer.back"] }).click();

  // ── Remove the second: no one has opened the album, and the relay answers 202 then 204 ──
  const second = ids[1] as string;
  relay.once(`DELETE /v1/media/${second}`, { status: 202 });
  await cells(page).nth(1).getByRole("button", { name: en["media.remove"] }).click();
  await expect(page.getByText(en["remove.unopened"])).toBeVisible();
  await page.getByRole("alertdialog").getByRole("button", { name: en["remove.confirm"], exact: true }).click();
  await expect(cells(page)).toHaveCount(1);
  await expect(page.getByText(en["remove.pending"](1))).toBeVisible();
  // Retried with backoff while the screen is open (2 s first), and cleared by the relay's 204.
  await expect(page.getByText(en["remove.pending"](1))).toHaveCount(0, { timeout: 15_000 });
  expect(relay.log.filter((r) => r.method === "DELETE").map((r) => r.path)).toEqual([`/v1/media/${second}`, `/v1/media/${second}`]);
  expect(relay.media.has(second)).toBe(false);

  // ── Back to the list: the count is items ────────────────────────────────
  await page.getByRole("button", { name: en["album.back"] }).click();
  await expect(page.getByText(en["albums.count"](1))).toBeVisible();

  assertNoFilenames(relay.log, [ANDROID, IPHONE, "wrong.jpg", "long.jpg"]);
  assertNoCaption(relay.log, CAPTION);
  const dump = await dumpStorage(page);
  expect(storageViolations(dump, [...spellings(ANDROID), ...spellings(IPHONE), ...captionSpellings(CAPTION)], { owner: true }), "storage").toEqual([]);
  expect(await violations(), "CSP violations and page errors").toEqual([]);
  await ctx.close();
});

test("a lost create response: the resend meets 409, and the same id goes on to the uploads", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { ctx, page, violations } = await signedUpInAlbum(browser, relay);
  const albumId = relay.log.find((r) => r.method === "POST" && r.path === "/v1/albums")?.body.match(/"id":"([0-9a-f-]{36})"/)?.[1];
  relay.once(`POST /v1/albums/${albumId}/media`, "store-then-drop");
  await add(page, [{ name: ANDROID, buffer: await phonePhoto(page, 1200, 900, 1) }]);

  await expect(page.getByText(en["offline.owner"])).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: en["offline.retry"] }).click();
  await expect(cells(page).nth(0)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });

  const creates = relay.log.filter((r) => r.method === "POST" && r.path.endsWith("/media"));
  expect(creates).toHaveLength(2);
  const createIds = creates.map((r) => (JSON.parse(r.body) as { id: string }).id);
  expect(new Set(createIds).size, "the same id, never a new one").toBe(1);
  const pathIds = new Set(mediaRoutes(relay).flatMap((r) => /\/v1\/media\/([0-9a-f-]{36})/.exec(r.path)?.[1] ?? []));
  expect([...pathIds]).toEqual([createIds[0]]);
  expect([...relay.media.keys()]).toEqual([createIds[0]]);
  expect(await violations()).toEqual([]);
  await ctx.close();
});

test("ready only on the server's word: an item the relay still calls processing is not shown as done", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { ctx, page } = await signedUpInAlbum(browser, relay);
  const release = relay.holdReady();
  await add(page, [{ name: ANDROID, buffer: await phonePhoto(page, 1200, 900, 1) }]);
  await expect(page.getByText(en["upload.waiting"])).toBeVisible({ timeout: 30_000 });
  // Both objects are stored; the relay says processing, so the cell stays as it is.
  await expect.poll(() => [...relay.media.values()][0]?.thumbnail !== null).toBe(true);
  await page.waitForTimeout(1500);
  await expect(cells(page).nth(0)).toHaveAttribute("data-state", "waiting");
  await expect(cells(page).locator("canvas")).toHaveCount(0);
  release();
  await expect(cells(page).nth(0)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await ctx.close();
});

// ── The guards, broken on purpose ─────────────────────────────────────────

test("a canvas that answers PNG: the photo fails on this device and nothing reaches the relay", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { ctx, page } = await signedUpInAlbum(browser, relay);
  // The fixture first, with the real toBlob; then the canvas breaks.
  const photo = await phonePhoto(page, 1200, 900, 1);
  await page.evaluate(() => {
    // What toBlob does, silently, for a type it cannot encode.
    const original = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (cb, _type, q) {
      return original.call(this, cb, "image/png", q);
    };
  });
  const before = relay.log.length;
  await add(page, [{ name: ANDROID, buffer: photo }]);
  await expect(page.getByText(en["upload.not-prepared"])).toBeVisible({ timeout: 30_000 });
  expect(mediaRoutes(relay).length).toBe(0);
  expect(relay.log.slice(before)).toEqual([]);
  await ctx.close();
});

/**
 * Wraps toBlob so every JPEG the app encodes is altered after the browser made it:
 * "app1" puts a camera's APP1 (EXIF, GPS) after SOI, which the filter must remove;
 * "hidden" puts an EXIF signature and GPS tag names in the image data after SOS,
 * which the filter keeps, so only the scan can catch them. Installed after the
 * fixture is made, which uses the real toBlob.
 */
async function alterCanvasJpeg(page: Page, mode: "app1" | "hidden"): Promise<void> {
  await page.evaluate(
    ([mode, app1, hidden]) => {
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (cb, type, q) {
        return original.call(
          this,
          (blob) => {
            if (blob === null) return cb(null);
            void blob.arrayBuffer().then((buf) => {
              const b = new Uint8Array(buf);
              let at = 2;
              if (mode === "hidden") {
                for (let i = 2; i + 3 < b.length; i++) {
                  if (b[i] === 0xff && b[i + 1] === 0xda) {
                    at = i + 2 + (((b[i + 2] as number) << 8) | (b[i + 3] as number));
                    break;
                  }
                }
              }
              const seg = new Uint8Array(mode === "app1" ? app1 : hidden);
              cb(new Blob([b.subarray(0, at), seg, b.subarray(at)], { type: blob.type }));
            });
          },
          type,
          q,
        );
      };
    },
    [mode, exifApp1(1), HIDDEN_EXIF] as const,
  );
}

test("the scan: EXIF and GPS hidden in the canvas JPEG's image data, where the filter keeps everything: the photo is never uploaded (#17)", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { ctx, page } = await signedUpInAlbum(browser, relay);
  const photo = await phonePhoto(page, 1200, 900, 1);
  await alterCanvasJpeg(page, "hidden");
  const before = relay.log.length;
  await add(page, [{ name: ANDROID, buffer: photo }]);
  // On the cell's state, not its text: with the scan broken, the failure prints what it got instead (e.g. "ready").
  await expect(cells(page).nth(0)).toHaveAttribute("data-state", "not-stripped", { timeout: 30_000 });
  await expect(page.getByText(en["upload.not-stripped"])).toBeVisible();
  expect(relay.log.slice(before)).toEqual([]);
  expect(relay.media.size, "no photo on the relay").toBe(0);
  await page.getByRole("button", { name: en["upload.dismiss"] }).click();
  await expect(cells(page)).toHaveCount(0);
  await ctx.close();
});

test("the filter: an APP1 with EXIF and GPS added to the canvas JPEG is removed, and the photo reaches ready", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { ctx, page, violations } = await signedUpInAlbum(browser, relay);
  const photo = await phonePhoto(page, 1200, 900, 1);
  await alterCanvasJpeg(page, "app1");
  await add(page, [{ name: ANDROID, buffer: photo }]);
  await expect(cells(page).nth(0)).toHaveAttribute("data-state", "ready", { timeout: 30_000 });
  await expect(page.getByText(en["upload.not-stripped"])).toHaveCount(0);
  expect(relay.media.size).toBe(1);
  expect(await violations()).toEqual([]);
  await ctx.close();
});

test("a canvas that reports a colour space other than sRGB: the photo fails on this device and nothing reaches the relay", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { ctx, page } = await signedUpInAlbum(browser, relay);
  // The fixture first, with the real canvas; then every context reports Display P3.
  const photo = await phonePhoto(page, 1200, 900, 1);
  await page.evaluate(() => {
    const original = CanvasRenderingContext2D.prototype.getContextAttributes;
    CanvasRenderingContext2D.prototype.getContextAttributes = function () {
      return { ...original.call(this), colorSpace: "display-p3" };
    };
  });
  const before = relay.log.length;
  await add(page, [{ name: ANDROID, buffer: photo }]);
  // On the cell's state, not its text: with the check broken, the failure prints what it got instead (e.g. "ready").
  await expect(cells(page).nth(0)).toHaveAttribute("data-state", "not-encoded", { timeout: 30_000 });
  await expect(page.getByText(en["upload.not-prepared"])).toBeVisible();
  expect(relay.log.slice(before)).toEqual([]);
  expect(relay.media.size, "no photo on the relay").toBe(0);
  await ctx.close();
});

test("the filename audit notices a filename in a request", () => {
  const leak: Logged[] = [{ method: "PUT", path: "/v1/media/x/asset", search: "", hash: "", body: "", headers: { "x-name": encodeURIComponent(ANDROID) } }];
  expect(() => assertNoFilenames(leak, [ANDROID])).toThrow(/filename in PUT/);
  const inBytes: Logged[] = [{ method: "PUT", path: "/v1/media/x/asset", search: "", hash: "", body: "", bytes: Buffer.from(`xx${ANDROID}xx`), headers: {} }];
  expect(() => assertNoFilenames(inBytes, [ANDROID])).toThrow(/filename in PUT/);
});

test("the caption audit notices a caption in a request, in any spelling", () => {
  for (const leak of [CAPTION, encodeURIComponent(CAPTION), JSON.stringify(CAPTION), Buffer.from(CAPTION).toString("base64")]) {
    const log: Logged[] = [{ method: "POST", path: "/v1/albums/x/media", search: "", hash: "", body: `{"metadata":"…","note":${JSON.stringify(leak)}}`, headers: {} }];
    expect(() => assertNoCaption(log, CAPTION)).toThrow(/caption in POST/);
  }
});

test("the storage check notices a filename written to sessionStorage", async ({ browser }) => {
  const relay = fakeRelay({ expiresInMs: 60_000 });
  const ctx = await browser.newContext();
  await relay.attach(ctx);
  const page = await ctx.newPage();
  await page.addInitScript((name) => sessionStorage.setItem("vitrina:upload", name), ANDROID);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: en["signin.title"] })).toBeVisible();
  const found = storageViolations(await dumpStorage(page), spellings(ANDROID), { owner: true });
  expect(found).toHaveLength(1);
  expect(found[0]).toMatch(/holds secret/);
  await ctx.close();
});
