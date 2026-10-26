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
 *
 * And in every test, across every request and all storage: no K_invite in
 * any spelling, no passphrase word, no raw token except as a recipient's own
 * bearer value, and no label in plaintext. No CSP violation, no page error.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import jsQR from "jsqr";
import { en } from "../../src/lib/copy/en.ts";
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
 * where a leak would put it: as a JSON string, a path segment or a query
 * value. The whole passphrase is searched for everywhere, in every joining.
 */
function passphraseSpellings(words: readonly string[]): string[] {
  const joined = [" ", "", "-", "+", "%20", ","].map((sep) => words.join(sep));
  const utf8 = Buffer.from(words.join(" "), "utf8");
  const encoded = [utf8.toString("base64"), utf8.toString("base64url"), utf8.toString("hex")];
  return [...joined, ...encoded, ...words.flatMap((w) => [`"${w}"`, `/${w}`, `=${w}`])];
}

/** Everything a request carried, as text: path, query, fragment, body, every header, and the raw body bytes. */
function carried(r: Logged, skipAuthorization = false): string[] {
  const headers = Object.entries(r.headers)
    .filter(([k]) => !(skipAuthorization && k === "authorization"))
    .map(([k, v]) => `${k}: ${v}`);
  return [r.path, r.search, r.hash, r.body, ...headers, r.bytes?.toString("latin1") ?? ""];
}

function assertAbsent(log: readonly Logged[], secrets: readonly string[], what: string, opts: { exceptBearer?: string } = {}): void {
  for (const r of log) {
    const isOwnBearer = opts.exceptBearer !== undefined && r.headers["authorization"] === `Bearer ${opts.exceptBearer}`;
    for (const place of carried(r, isOwnBearer)) for (const s of secrets) expect(place.includes(s), `${what} in ${r.method} ${r.path}`).toBe(false);
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

/** Signed up, one album, one photo at ready: an owner with something to share. */
async function ownerWithPhoto(browser: Browser, relay: Relay) {
  const ctx = await browser.newContext();
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
  const ctx = await browser.newContext();
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
  await expect(owner.page.getByRole("alertdialog")).toContainText(en["revoke.confirm"]);
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
  assertAbsent(relay.log, [...passphraseSpellings(words), ...labelSpellings(LABEL)], "the passphrase or the label");
  assertAbsent(relay.log, spellingsOf(token), "the raw token", { exceptBearer: token });
  expect(storageViolations(await dumpStorage(owner.page), [...passphraseSpellings(words), ...spellingsOf(token), LABEL], { owner: true })).toEqual([]);
  expect(storageViolations(await dumpStorage(r.page), [...passphraseSpellings(words), LABEL], { recipientInvite: fragmentOf(link) })).toEqual([]);
  expect(await owner.violations()).toEqual([]);
  expect(await r.violations()).toEqual([]);
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
