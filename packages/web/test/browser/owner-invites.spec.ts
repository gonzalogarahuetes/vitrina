/*
 * Invites, invited people, revoke and the access log in a real browser: the
 * production build, the real WASM, the owner's real invite functions, and the
 * fake relay (relay.ts), which stores what the owner's page posts and answers
 * a recipient's bearer token by hashing it as the real relay does. So a link
 * opens the album in the second browser context only if the owner's page got
 * every half right: the id in the wrap AAD, K_invite in the fragment, the
 * token's hash posted and the token itself not, and the label under K_label.
 *
 *   1. The loop: an owner creates a QR invite in one context; the QR on the
 *      page decodes to the link shown; a recipient opens the link in another
 *      context and sees the album; the owner sees the open, revokes, and the
 *      recipient's next load is the revoked screen. The log names it.
 *   2. A passphrase invite: the derivation wait, the words with no copy
 *      button, and the recipient opening it with those words.
 *   3. A 409: the share screen shows the second attempt's secrets only.
 *   4. The share screen is shown once: leaving asks, and afterwards the page,
 *      storage and history hold nothing of it.
 *   5. The passphrase language defaults to the interface language (brief
 *      §15.2): Spanish words when the interface is Spanish, and still
 *      changeable.
 *
 * And in every test, across every request and all storage: no K_invite in
 * any spelling, no passphrase word, no raw token except as a recipient's own
 * bearer value, and no label in plaintext. No CSP violation, no page error.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import jsQR from "jsqr";
import { readFileSync } from "node:fs";
import { en } from "../../src/lib/copy/en.ts";
import { es } from "../../src/lib/copy/es.ts";
import { autonym } from "../../src/lib/copy/format.ts";
import { storageViolations } from "../storage-allowlist.ts";
import { dumpStorage, text, watch } from "./helpers.ts";
import { fakeRelay, type Logged } from "./relay.ts";

const EMAIL = "parent@example.com";
const PASSWORD = "copper kettle under the stairs 47";
const ARGON = 60_000;
const LABEL = "María Fernández";
const ALBUM_TITLE = "Verano 2026";
const INVITE_ENTRY = "vitrina:recipient:invite";

type Relay = ReturnType<typeof fakeRelay>;

/** Every spelling of 32 secret bytes the leak search looks for. */
function spellingsOf(b64url: string): string[] {
  const raw = Buffer.from(b64url, "base64url");
  const std = raw.toString("base64");
  return [b64url, std, std.replace(/=+$/, ""), raw.toString("hex"), raw.toString("hex").toUpperCase(), encodeURIComponent(std)];
}

/** A label's plaintext as it could leak: as text, JSON-escaped, and base64 of its UTF-8. */
function labelSpellings(label: string): string[] {
  const utf8 = Buffer.from(label, "utf8");
  return [
    label,
    JSON.stringify(label).slice(1, -1).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
    utf8.toString("latin1"),
    utf8.toString("base64"),
    utf8.toString("base64url"),
    encodeURIComponent(label),
  ];
}

/**
 * The passphrase as it could leak. A single short word may occur by chance in
 * ordinary request text ("content-type"), so each word is searched for only
 * where a leak would put it: as a JSON string or a whole query value. The
 * whole passphrase is searched for everywhere, in every joining.
 *
 * Not in a path: a path is checked against api-sketch §11.8 instead
 * (assertRoutesOnly), because the passphrase lists hold the API's own words.
 * EFF has "album", "recipient" and "revoke"; the Spanish list has "media".
 * Searched for as "/word", a clean run failed about one time in 500 (a
 * "recipient" passphrase and POST /v1/albums/{id}/recipients, 26 October
 * 2026, repeat 18 of 20), and as a whole segment it still would, on
 * GET /v1/recipient/key.
 */
function passphraseSpellings(words: readonly string[]): (string | RegExp)[] {
  const joined = [" ", "", "-", "+", "%20", ","].map((sep) => words.join(sep));
  const utf8 = Buffer.from(words.join(" "), "utf8");
  const encoded = [utf8.toString("base64"), utf8.toString("base64url"), utf8.toString("hex")];
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const value = (v: string) => new RegExp(`=${esc(v)}(?=[&#]|$)`);
  const placed = words.flatMap((w) => [`"${w}"`, value(w), value(encodeURIComponent(w))]);
  return [...joined, ...encoded, ...placed];
}

/** Api-sketch §11.8, every route, each id a UUID. A path that is one of these has nowhere for a word to be. */
const ROUTES = [
  "/v1/albums",
  "/v1/albums/{id}",
  "/v1/albums/{id}/access-log",
  "/v1/albums/{id}/access-log/entries",
  "/v1/albums/{id}/metadata",
  "/v1/albums/{id}/media",
  "/v1/albums/{id}/recipients",
  "/v1/media/{id}",
  "/v1/media/{id}/asset",
  "/v1/media/{id}/thumbnail",
  "/v1/owner/key",
  "/v1/recipient",
  "/v1/recipient/key",
  "/v1/recipients/{id}/revoke",
  "/v1/login",
  "/v1/login/params",
  "/v1/logout",
  "/v1/logout/all",
  "/v1/signup",
].map((r) => new RegExp(`^${r.replaceAll("{id}", "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")}$`));

/** Every request's path is a §11.8 route with UUIDs where its ids go: nothing else, a word included, rode in a path. */
function assertRoutesOnly(log: readonly Logged[]): void {
  for (const r of log) expect(ROUTES.some((route) => route.test(r.path)), `${r.method} ${r.path} is an api-sketch §11.8 route`).toBe(true);
}

const found = (place: string, s: string | RegExp): boolean => (typeof s === "string" ? place.includes(s) : s.test(place));

/** Everything a request carried, as text: path, query, fragment, body, every header, and the raw body bytes. */
function carried(r: Logged, skipAuthorization = false): string[] {
  const headers = Object.entries(r.headers)
    .filter(([k]) => !(skipAuthorization && k === "authorization"))
    .map(([k, v]) => `${k}: ${v}`);
  return [r.path, r.search, r.hash, r.body, ...headers, r.bytes?.toString("latin1") ?? ""];
}

function assertAbsent(log: readonly Logged[], secrets: readonly (string | RegExp)[], what: string, opts: { exceptBearer?: string } = {}): void {
  for (const r of log) {
    const isOwnBearer = opts.exceptBearer !== undefined && r.headers["authorization"] === `Bearer ${opts.exceptBearer}`;
    for (const place of carried(r, isOwnBearer)) for (const s of secrets) expect(found(place, s), `${what} in ${r.method} ${r.path}`).toBe(false);
  }
}

/** The QR as the page drew it: the SVG path's runs, rasterised, decoded by a second implementation. */
async function decodeQr(page: Page): Promise<string | null> {
  const svg = page.locator("svg.qr");
  await expect(svg).toBeVisible();
  const [viewBox, d] = await Promise.all([svg.getAttribute("viewBox"), svg.locator("path").getAttribute("d")]);
  const size = Number(viewBox?.split(" ")[2]);
  const scale = 6;
  const side = size * scale;
  const px = new Uint8ClampedArray(side * side * 4).fill(255);
  for (const [, x, y, w] of (d ?? "").matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let dy = 0; dy < scale; dy++) {
      for (let dx = 0; dx < Number(w) * scale; dx++) {
        const i = ((Number(y) * scale + dy) * side + Number(x) * scale + dx) * 4;
        px.fill(0, i, i + 3);
      }
    }
  }
  return jsQR(px, side, side)?.data ?? null;
}

async function canvasJpeg(page: Page, w: number, h: number): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ([w, h]) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { colorSpace: "srgb" }) as CanvasRenderingContext2D;
      ctx.fillStyle = "#2a6f97";
      ctx.fillRect(0, 0, w, h);
      const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/jpeg", 0.9));
      return Array.from(new Uint8Array(await (blob as Blob).arrayBuffer()));
    },
    [w, h] as const,
  );
  return Buffer.from(bytes);
}

/**
 * Every context a test here opens, closed when it ends. Left open, each owner
 * context keeps an unlocked session, its WASM and its Argon2id memory alive in
 * the worker's browser; under --repeat-each=20 they piled up until WebKit
 * stopped answering mid-test (26 October 2026: a .check() that never returned,
 * 17 live contexts in the trace). The other specs already close theirs.
 */
const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
});

async function newContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  opened.push(ctx);
  return ctx;
}

/** Signed up, one album, one photo at ready: an owner with something to share. */
async function ownerWithPhoto(browser: Browser, relay: Relay) {
  const ctx = await newContext(browser);
  await relay.attach(ctx);
  const page = await ctx.newPage();
  const violations = await watch(page);
  const urls: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) urls.push(f.url());
  });
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
  await page.locator("#add-photos").setInputFiles([{ name: "photo.jpg", mimeType: "image/jpeg", buffer: await canvasJpeg(page, 1200, 900) }]);
  // The review (flows §3.6): no caption here; viewer.spec.ts covers captions.
  await page.getByRole("button", { name: en["upload.review.send"](1) }).click();
  await expect(page.getByRole("button", { name: en["album.photo.a11y"](1, 1) })).toBeVisible({ timeout: 60_000 });
  const albumId = JSON.parse(relay.log.find((r) => r.method === "POST" && r.path === "/v1/albums")?.body ?? "{}").id as string;
  return { ctx, page, violations, urls, albumId };
}

async function createInvite(page: Page, mode: "qr" | "passphrase"): Promise<void> {
  await page.getByRole("button", { name: en["album.invite"] }).click();
  await expect(page.getByRole("heading", { name: en["invite.title"] })).toBeVisible();
  await page.getByLabel(en["invite.name.label"]).fill(LABEL);
  if (mode === "passphrase") {
    await page.locator('input[name="invite-mode"][value="passphrase"]').check();
    await expect(page.getByLabel(en["invite.language"])).toBeVisible();
  }
  await page.getByRole("button", { name: en["invite.create"] }).click();
  await expect(page.getByRole("heading", { name: en["invite.share.title"](LABEL) })).toBeVisible({ timeout: ARGON });
}

async function recipientContext(browser: Browser, relay: Relay): Promise<{ ctx: BrowserContext; page: Page; violations: () => Promise<string[]> }> {
  const ctx = await newContext(browser);
  await relay.attach(ctx);
  const page = await ctx.newPage();
  return { ctx, page, violations: await watch(page) };
}

const fragmentOf = (link: string) => link.slice(link.indexOf("#"));
const param = (link: string, k: string) => new URLSearchParams(fragmentOf(link).slice(1)).get(k) ?? "";
const sha256b64 = (b64url: string) => createHash("sha256").update(Buffer.from(b64url, "base64url")).digest("base64url");

test("the loop: a QR invite made in one context opens the album in another, and revoking it changes the recipient's screen", async ({ browser }) => {
  test.setTimeout(240_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const owner = await ownerWithPhoto(browser, relay);

  await createInvite(owner.page, "qr");
  const link = (await owner.page.locator("[data-invite-link]").textContent()) ?? "";
  expect(link.startsWith(`${new URL(owner.page.url()).origin}/v/#`), "the fragment, never a query (invite spec §2.1)").toBe(true);
  expect(link).not.toContain("?");
  await expect(owner.page.getByText(en["invite.housekey"])).toBeVisible();
  await expect(owner.page.getByText(en["invite.once"])).toBeVisible();
  expect(await decodeQr(owner.page), "the QR on the page is the link").toBe(link);
  expect(await owner.page.locator('img[src^="data:"], [style*="data:"]').count(), "never a data: image").toBe(0);

  const token = param(link, "t");
  const key = param(link, "k");
  expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);

  // What the relay holds: the hash of this token, a wrapping, a label it cannot read. Nothing else.
  const [row] = [...relay.recipients.values()];
  expect(row?.body["token_hash"], "the posted hash is SHA-256 of the token's 32 bytes").toBe(sha256b64(token));
  expect(row?.body["kind"]).toBe("qr");
  expect(Object.keys(row?.body ?? {}).sort()).toEqual(["id", "kind", "label", "token_hash", "wrap_nonce", "wrapped"]);

  // ── The recipient, in another context ──────────────────────────────────
  const r = await recipientContext(browser, relay);
  await r.page.goto(link);
  await r.page.getByRole("button", { name: en["onboarding.continue"] }).click();
  await expect(r.page.getByRole("button", { name: en["grid.photo.a11y"](1, 1) })).toBeVisible({ timeout: 30_000 });
  expect(new URL(r.page.url()).hash, "the fragment is stripped").toBe("");
  await r.page.getByRole("button", { name: en["grid.photo.a11y"](1, 1) }).click();
  // Shown: Zoom in becomes available (an unavailable control is aria-disabled, not disabled).
  await expect(r.page.getByRole("button", { name: en["viewer.zoom-in"] })).toBeVisible();
  await expect(r.page.getByRole("button", { name: en["viewer.zoom-in"] })).not.toHaveAttribute("aria-disabled", "true", { timeout: 30_000 });
  await r.page.getByRole("button", { name: en["viewer.back"] }).click();

  // ── The owner: leave the share screen (asked first), see the open, revoke ──
  await owner.page.getByRole("button", { name: en["invite.done"] }).click();
  await expect(owner.page.getByRole("alertdialog")).toContainText(en["invite.leave.consequence"]);
  await owner.page.getByRole("button", { name: en["invite.leave.confirm"] }).click();
  await expect(owner.page.getByRole("heading", { name: ALBUM_TITLE, exact: true })).toBeVisible();
  expect(await owner.page.content(), "the link left with its screen").not.toContain(token);

  await owner.page.getByRole("button", { name: en["album.people"] }).click();
  const person = owner.page.locator("li.person");
  await expect(person.getByRole("heading", { name: LABEL })).toBeVisible();
  await expect(person.getByText(en["log.summary.opens"](1))).toBeVisible();
  await expect(person.getByText(en["log.summary.photos"](1))).toBeVisible();
  await expect(owner.page.getByText(en["log.sparse"])).toBeVisible();

  await person.getByRole("button", { name: en["people.log.person"](LABEL) }).click();
  await expect(owner.page.getByText(en["log.entry.photo"](LABEL))).toBeVisible();
  await expect(owner.page.getByText(en["log.entry.album"](LABEL))).toBeVisible();
  await expect(owner.page.getByRole("img", { name: en["log.photo.a11y"] })).toBeVisible();
  await owner.page.getByRole("button", { name: en["log.back"] }).click();

  await person.getByRole("button", { name: en["people.revoke"] }).click();
  await expect(owner.page.getByRole("alertdialog")).toContainText(en["revoke.confirm"](LABEL));
  await owner.page.getByRole("alertdialog").getByRole("button", { name: en["revoke.yes"] }).click();
  await expect(owner.page.getByText(en["revoke.done"])).toBeVisible();
  expect(relay.log.filter((x) => x.path.endsWith("/revoke")).map((x) => [x.method, x.body, x.headers["content-type"]])).toEqual([["POST", "", undefined]]);

  // ── The recipient's screen changes: the next load is refused ────────────
  await r.page.reload();
  await text(en.revoked)(r.page);

  // ── Nothing leaked, anywhere ────────────────────────────────────────────
  const secrets = [...spellingsOf(key), ...labelSpellings(LABEL)];
  assertAbsent(relay.log, secrets, "K_invite or the label");
  assertAbsent(relay.log, spellingsOf(token), "the raw token", { exceptBearer: token });
  expect(JSON.stringify([...relay.recipients.values()]), "the relay's row").not.toMatch(new RegExp([key, token, LABEL].join("|")));
  expect(owner.urls.every((u) => !u.includes("#")), "the owner's address bar never held the link").toBe(true);
  expect(storageViolations(await dumpStorage(owner.page), [...secrets, ...spellingsOf(token)], { owner: true }), "owner storage").toEqual([]);
  expect(storageViolations(await dumpStorage(r.page), [...secrets, ...spellingsOf(token)]), "recipient storage after revoke").toEqual([]);
  expect(await owner.violations(), "owner: CSP violations and page errors").toEqual([]);
  expect(await r.violations(), "recipient: CSP violations and page errors").toEqual([]);
});

test("a passphrase invite: the derivation wait, the words with no copy button, and the recipient opens it with them", async ({ browser }) => {
  test.setTimeout(240_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const owner = await ownerWithPhoto(browser, relay);

  await createInvite(owner.page, "passphrase");
  const link = (await owner.page.locator("[data-invite-link]").textContent()) ?? "";
  expect(param(link, "k"), "no key in a passphrase link (invite spec §4)").toBe("");
  const words = await owner.page.locator("[data-passphrase] li").allTextContents();
  expect(words.length).toBeGreaterThanOrEqual(5);
  await expect(owner.page.getByText(en["invite.channels"])).toBeVisible();
  await expect(owner.page.getByText(en["invite.housekey.passphrase"])).toBeVisible();
  expect(await owner.page.locator("svg.qr").count(), "no QR for a passphrase invite").toBe(0);
  // One copy button, for the link. None near the words.
  await expect(owner.page.getByRole("button", { name: en["invite.link.copy"] })).toHaveCount(1);
  expect(await owner.page.locator("section.words button").count()).toBe(0);
  expect(await owner.page.getByRole("button", { name: /copy/i }).count()).toBe(1);

  const [row] = [...relay.recipients.values()];
  expect(row?.body).toMatchObject({ kind: "passphrase", kdf_memory_kib: 65536, kdf_iterations: 3, kdf_parallelism: 1 });
  expect(row?.body["token_hash"]).toBe(sha256b64(param(link, "t")));

  const r = await recipientContext(browser, relay);
  await r.page.goto(link);
  await expect(r.page.getByRole("heading", { name: en["recipient.passphrase.title"] })).toBeVisible();
  for (const [i, word] of words.entries()) await r.page.getByLabel(en["recipient.passphrase.word"](i + 1)).fill(word);
  await r.page.getByRole("button", { name: en["recipient.passphrase.submit"] }).click();
  await r.page.getByRole("button", { name: en["onboarding.continue"] }).click({ timeout: ARGON });
  await expect(r.page.getByRole("button", { name: en["grid.photo.a11y"](1, 1) })).toBeVisible({ timeout: 30_000 });

  const token = param(link, "t");
  assertRoutesOnly(relay.log);
  assertAbsent(relay.log, [...passphraseSpellings(words), ...labelSpellings(LABEL)], "the passphrase or the label");
  assertAbsent(relay.log, spellingsOf(token), "the raw token", { exceptBearer: token });
  // Storage is searched as text by storage-allowlist.ts: the string spellings. Storage holds no URLs, so no segment form is lost.
  const stored = passphraseSpellings(words).filter((x): x is string => typeof x === "string");
  expect(storageViolations(await dumpStorage(owner.page), [...stored, ...spellingsOf(token), LABEL], { owner: true })).toEqual([]);
  expect(storageViolations(await dumpStorage(r.page), [...stored, LABEL], { recipientInvite: fragmentOf(link) })).toEqual([]);
  expect(await owner.violations()).toEqual([]);
  expect(await r.violations()).toEqual([]);
});

test("the passphrase search: a word in a path is a path that is no route, and elsewhere a whole JSON string or query value", () => {
  const req = (path: string, search = "", body = ""): Logged => ({ method: "POST", path, search, hash: "", body, headers: {} });
  const fails = (check: () => void) => {
    try {
      check();
      return false;
    } catch {
      return true;
    }
  };
  const id = "c58c3542-e1ed-4aa2-aa94-db1ac128a913";
  const words = ["recipient", "album", "revoke", "media", "sullen"];
  const word = (r: Logged) => fails(() => assertAbsent([r], passphraseSpellings(words), "a word"));
  const route = (r: Logged) => fails(() => assertRoutesOnly([r]));

  // The routes themselves, which hold these words as their own: never a finding.
  for (const path of [`/v1/albums/${id}/recipients`, "/v1/recipient", "/v1/recipient/key", `/v1/recipients/${id}/revoke`, `/v1/media/${id}/asset`]) {
    expect(route(req(path)), path).toBe(false);
    expect(word(req(path)), path).toBe(false);
  }
  // A word in a path: no longer a route.
  for (const path of ["/v1/sullen", `/v1/albums/${id}/sullen`, `/v1/albums/sullen`, "/v1/recipient/key/sullen", `/v1/media/sullen/asset`, "/sullen/v1/recipient", "/v1/recipient/"]) expect(route(req(path)), path).toBe(true);
  // A word where a request carries text.
  expect(word(req("/v1/recipient", "?w=sullen"))).toBe(true);
  expect(word(req("/v1/recipient", "?w=sullen&z=1"))).toBe(true);
  expect(word(req("/v1/recipient", "?w=sullenly"))).toBe(false);
  expect(word(req("/v1/recipient", "", '{"w":"recipient"}'))).toBe(true);
  expect(word(req("/v1/recipient", "", '{"kind":"passphrase"}'))).toBe(false);
  expect(word(req("/v1/recipient", "", words.join(" ")))).toBe(true);
});

test("a 409 regenerates: the share screen carries only the second attempt's token and key", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const owner = await ownerWithPhoto(browser, relay);
  relay.once(`POST /v1/albums/${owner.albumId}/recipients`, { status: 409 });
  await createInvite(owner.page, "qr");
  const posts = relay.log.filter((x) => x.method === "POST" && x.path.endsWith("/recipients")).map((x) => JSON.parse(x.body) as Record<string, string>);
  expect(posts).toHaveLength(2);
  expect(posts[1]?.["id"]).not.toBe(posts[0]?.["id"]);
  expect(posts[1]?.["token_hash"]).not.toBe(posts[0]?.["token_hash"]);
  expect(posts[1]?.["wrapped"]).not.toBe(posts[0]?.["wrapped"]);
  expect(posts[1]?.["label"]).not.toBe(posts[0]?.["label"]);
  const link = (await owner.page.locator("[data-invite-link]").textContent()) ?? "";
  expect(sha256b64(param(link, "t")), "the link's token is the one the relay accepted").toBe(posts[1]?.["token_hash"]);
  expect(await decodeQr(owner.page)).toBe(link);
  expect(await owner.violations()).toEqual([]);
});

test("the share screen is shown once: leaving asks, and nothing of it stays in the page, storage or history", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const owner = await ownerWithPhoto(browser, relay);
  await createInvite(owner.page, "qr");
  const link = (await owner.page.locator("[data-invite-link]").textContent()) ?? "";

  await owner.page.getByRole("button", { name: en["invite.done"] }).click();
  await owner.page.getByRole("button", { name: en["invite.leave.stay"] }).click();
  await expect(owner.page.locator("[data-invite-link]")).toHaveText(link);

  await owner.page.getByRole("button", { name: en["invite.done"] }).click();
  await owner.page.getByRole("button", { name: en["invite.leave.confirm"] }).click();
  await expect(owner.page.getByRole("heading", { name: ALBUM_TITLE, exact: true })).toBeVisible();
  const html = await owner.page.content();
  for (const s of [param(link, "t"), param(link, "k")]) expect(html).not.toContain(s);
  const dump = await dumpStorage(owner.page);
  expect(storageViolations(dump, [...spellingsOf(param(link, "t")), ...spellingsOf(param(link, "k")), LABEL], { owner: true })).toEqual([]);
  expect(JSON.stringify(dump.historyState ?? null)).not.toContain(param(link, "t"));
  expect(dump.sessionStorage[INVITE_ENTRY], "the owner's tab never holds a recipient entry").toBeUndefined();
  expect(await owner.violations()).toEqual([]);
});

test("a lost create response, then a 409: the new invite is shared, and the row nobody can use is listed as revoked", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const owner = await ownerWithPhoto(browser, relay);
  relay.once(`POST /v1/albums/${owner.albumId}/recipients`, "store-then-drop");
  await owner.page.getByRole("button", { name: en["album.invite"] }).click();
  await owner.page.getByLabel(en["invite.name.label"]).fill(LABEL);
  await owner.page.getByRole("button", { name: en["invite.create"] }).click();
  // The response never came: the offline state, then the same body again, which the relay answers 409.
  await owner.page.getByRole("button", { name: en["offline.retry"] }).click();
  await expect(owner.page.getByRole("heading", { name: en["invite.share.title"](LABEL) })).toBeVisible({ timeout: ARGON });

  const rows = [...relay.recipients.entries()];
  expect(rows).toHaveLength(2);
  const link = (await owner.page.locator("[data-invite-link]").textContent()) ?? "";
  const shared = rows.find(([, r]) => r.body["token_hash"] === sha256b64(param(link, "t")));
  const orphan = rows.find(([id]) => id !== shared?.[0]);
  await expect.poll(() => orphan?.[1].revoked_at ?? null, { message: "the abandoned row is revoked" }).not.toBeNull();
  expect(shared?.[1].revoked_at, "never the one just shared").toBeNull();

  await owner.page.getByRole("button", { name: en["invite.done"] }).click();
  await owner.page.getByRole("button", { name: en["invite.leave.confirm"] }).click();
  await owner.page.getByRole("button", { name: en["album.people"] }).click();
  const people = owner.page.locator("li.person");
  await expect(people).toHaveCount(2);
  await expect(owner.page.locator("li.person.revoked")).toHaveCount(1);
  expect(await owner.violations()).toEqual([]);
});

test("the passphrase language defaults to the interface language, and stays changeable (brief §15.2)", async ({ browser }) => {
  test.setTimeout(240_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const owner = await ownerWithPhoto(browser, relay);
  const page = owner.page;
  const choice = (name: string) => page.locator("[data-language-switch]").first().getByRole("button", { name, exact: true });
  const SPANISH_WORDS = new Set(readFileSync(new URL("../../src/lib/owner/wordlists/es.txt", import.meta.url), "utf8").split(/\r?\n/).filter((w) => w !== ""));

  // English interface: the default is English.
  await page.getByRole("button", { name: en["album.invite"] }).click();
  await page.locator('input[name="invite-mode"][value="passphrase"]').check();
  await expect(page.getByLabel(en["invite.language"])).toHaveValue("en");
  await page.getByRole("button", { name: en["invite.back"] }).click();
  await expect(page.getByRole("heading", { name: ALBUM_TITLE, exact: true })).toBeVisible();

  // Spanish interface: the default is Spanish, the example watermark carries a Spanish date, and English is still offered.
  await choice(autonym("es")).click();
  await page.getByRole("button", { name: es["album.invite"] }).click();
  await expect(page.getByRole("heading", { name: es["invite.title"] })).toBeVisible();
  const example = await page.evaluate(() => new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "short", year: "numeric" }).format(new Date(2026, 7, 6)));
  await expect(page.getByText(es["invite.name.hint"](es.watermark("María", example)))).toBeVisible();
  await page.getByLabel(es["invite.name.label"]).fill(LABEL);
  await page.locator('input[name="invite-mode"][value="passphrase"]').check();
  const select = page.getByLabel(es["invite.language"]);
  await expect(select).toHaveValue("es");
  await expect(select.locator("option")).toHaveText(["Inglés", "Español"]);
  await select.selectOption("en");
  await select.selectOption("es");

  await page.getByRole("button", { name: es["invite.create"] }).click();
  await expect(page.getByRole("heading", { name: es["invite.share.title"](LABEL) })).toBeVisible({ timeout: ARGON });
  await expect(page.getByText(es["invite.passphrase.language"]("español"))).toBeVisible();
  await expect(page.getByText(es["invite.housekey.passphrase"])).toBeVisible();
  const words = await page.locator("[data-passphrase] li").allTextContents();
  expect(words.length).toBeGreaterThanOrEqual(5);
  for (const w of words) expect(SPANISH_WORDS.has(w.trim()), `${w} is from the Spanish list`).toBe(true);
  assertRoutesOnly(relay.log);
  assertAbsent(relay.log, passphraseSpellings(words.map((w) => w.trim())), "the Spanish passphrase");
  expect(await owner.violations()).toEqual([]);
});
