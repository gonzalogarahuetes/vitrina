/*
 * Flows §4.7 in a real browser: a reload of the same tab continues, from the
 * fragment the tab kept in sessionStorage (lib/session/recipient-session.ts).
 * The production build, the real WASM, the owner's real openInviteKey and
 * openPassphraseKey, and a faked API (a relay in this file, behind
 * context.route) whose fixtures are made here with the same envelope build,
 * as an owner's client would make them (encryption spec §6.1, §6.2).
 *
 *   1. A QR invite: open it, reach the grid, reload. The link is gone from
 *      the address bar, the tab kept exactly the fragment, /recipient/key is
 *      fetched again and K_invite unwraps again: back to the grid.
 *   2. A passphrase invite: reload, and the words are asked for again — the
 *      fragment carries no key, so nothing opens without them. They still work.
 *   3. Revoke, reload: the revoked screen, and the entry is gone, so a
 *      further reload is the dead page.
 *
 *   4. In Spanish (brief §15): onboarding is brief §16's Spanish reference
 *      text, the grid is Spanish, a switch to English mid-visit holds, and the
 *      reload starts again from the device's language, storing nothing new.
 *
 * Storage at each stop is judged by test/storage-allowlist.ts with the one
 * entry flows §4.7 permits; K_invite in any other place fails it.
 */
import { expect, test, type BrowserContext, type Route } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { en } from "../../src/lib/copy/en.ts";
import { es } from "../../src/lib/copy/es.ts";
import { autonym } from "../../src/lib/copy/format.ts";
import { storageViolations } from "../storage-allowlist.ts";
import { apiOrigin, dumpStorage, text, watch } from "./helpers.ts";

const WASM_DIR = new URL("../../../envelope/wasm/", import.meta.url);
const INVITE_ENTRY = "vitrina:recipient:invite";

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const idBytes = (uuid: string) => Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex"));

/** A valid 1×1 PNG: the thumbnail must decode, or its cell fails. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const WORDS = ["lantern", "orchard", "pebble", "meadow", "harbour"];

type Recipient = { id: string; token: string; kind: "qr" | "passphrase"; key: Record<string, unknown>; label: string; revoked: boolean };

/** The album, its two invites and the relay's answers, all made with the real envelope build. */
async function fixtures() {
  const { default: init, ...envelope } = await import(new URL("envelope.js", WASM_DIR).href);
  await init({ module_or_path: await readFile(new URL("envelope_bg.wasm", WASM_DIR)) });

  const albumId = randomUUID();
  const mediaId = randomUUID();
  const album = envelope.AlbumKey.generate();

  const qrId = randomUUID();
  const invite = envelope.InviteKey.generate();
  const inviteWrapping = envelope.wrapAlbumKeyForInvite(album, invite, idBytes(qrId));
  const inviteKey = invite.toInviteBytes() as Uint8Array;
  invite.free();

  const passId = randomUUID();
  const params = new envelope.WrapParams(16384, 2, 1);
  const passWrapping = envelope.wrapAlbumKey(album, WORDS.join(" "), params, idBytes(passId));

  const recipients: Recipient[] = [
    {
      id: qrId,
      token: randomBytes(32).toString("base64url"),
      kind: "qr",
      key: { id: qrId, kind: "qr", wrapped: b64(inviteWrapping.wrapped), wrap_nonce: b64(inviteWrapping.wrapNonce) },
      label: b64(envelope.encryptRecipientLabel(album, idBytes(qrId), "María")),
      revoked: false,
    },
    {
      id: passId,
      token: randomBytes(32).toString("base64url"),
      kind: "passphrase",
      key: {
        id: passId,
        kind: "passphrase",
        kdf_salt: b64(passWrapping.kdfSalt),
        kdf_memory_kib: 16384,
        kdf_iterations: 2,
        kdf_parallelism: 1,
        wrapped: b64(passWrapping.wrapped),
        wrap_nonce: b64(passWrapping.wrapNonce),
      },
      label: b64(envelope.encryptRecipientLabel(album, idBytes(passId), "Abuelo")),
      revoked: false,
    },
  ];

  const albumJson = {
    id: albumId,
    title: b64(envelope.encryptAlbumTitle(album, idBytes(albumId), "Verano 2026")),
    created_at: "2026-10-01T00:00:00Z",
    media: [{ id: mediaId, kind: "photo", status: "ready", created_at: "2026-10-01T00:00:00Z" }],
  };
  const metadata = { metadata: [{ media_id: mediaId, envelope: b64(envelope.encryptMeta(album, idBytes(mediaId), Buffer.from('{"width":1,"height":1}'))) }] };
  const thumbnail = envelope.encryptThumb(album, idBytes(mediaId), PNG) as Uint8Array;
  album.free();

  const base = `v=1&a=${b64(idBytes(albumId))}`;
  const qr = recipients[0] as Recipient;
  const pass = recipients[1] as Recipient;
  return {
    recipients,
    albumId,
    albumJson,
    metadata,
    mediaId,
    thumbnail,
    qr,
    pass,
    qrFragment: `#${base}&t=${qr.token}&k=${b64(inviteKey)}`,
    passFragment: `#${base}&t=${pass.token}`,
    /** K_invite in the spellings the secret search looks for. */
    inviteSecrets: [b64(inviteKey), Buffer.from(inviteKey).toString("base64"), Buffer.from(inviteKey).toString("hex")],
  };
}

type Fixtures = Awaited<ReturnType<typeof fixtures>>;

/** Every request the app makes to the API, answered from the fixtures; CORS as a real relay sends it. */
async function relay(context: BrowserContext, f: Fixtures, pageOrigin: string): Promise<{ paths: string[] }> {
  const paths: string[] = [];
  const origin = apiOrigin();
  async function handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const cors = {
      "access-control-allow-origin": pageOrigin,
      "access-control-allow-headers": "authorization, content-type, range",
      "access-control-allow-methods": "GET",
      "access-control-expose-headers": "retry-after",
      "cache-control": "no-store",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    paths.push(url.pathname);
    const json = (status: number, value: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(value) });
    const token = (await req.allHeaders())["authorization"]?.replace(/^Bearer /, "");
    const r = f.recipients.find((x) => x.token === token);
    if (r === undefined) return json(401, { code: "UNAUTHENTICATED", message: "x" });
    if (r.revoked) return json(403, { code: "ACCESS_REVOKED", message: "x" });
    switch (url.pathname) {
      case "/v1/recipient/key":
        return json(200, r.key);
      case "/v1/recipient":
        return json(200, { id: r.id, album_id: f.albumId, label: r.label, kind: r.kind, created_at: "2026-10-01T00:00:00Z" });
      case `/v1/albums/${f.albumId}`:
        return json(200, f.albumJson);
      case `/v1/albums/${f.albumId}/metadata`:
        return json(200, f.metadata);
      case `/v1/media/${f.mediaId}/thumbnail`:
        return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/octet-stream" }, body: Buffer.from(f.thumbnail) });
      default:
        return json(404, { code: "NOT_FOUND", message: "x" });
    }
  }
  await context.route((u) => u.origin === origin, handle);
  return { paths };
}

const photo = en["grid.photo.a11y"](1, 1);

test.describe("a reload of the same tab continues (flows §4.7)", () => {
  let f: Fixtures;
  test.beforeAll(async () => {
    f = await fixtures();
  });
  test.beforeEach(() => {
    for (const r of f.recipients) r.revoked = false;
  });

  test("a QR invite: reload, and K_invite unwraps again, back to the grid without the link", async ({ page, context, baseURL }) => {
    const violations = await watch(page);
    const api = await relay(context, f, new URL(baseURL ?? "").origin);

    await page.goto(`/v/${f.qrFragment}`);
    await page.getByRole("button", { name: en["onboarding.continue"] }).click();
    await expect(page.getByRole("button", { name: photo })).toBeVisible();
    expect(new URL(page.url()).hash, "the fragment is stripped").toBe("");

    api.paths.length = 0;
    await page.reload();
    await page.waitForLoadState("load");
    expect(new URL(page.url()).hash, "the reload carries no link").toBe("");
    await page.getByRole("button", { name: en["onboarding.continue"] }).click();
    await expect(page.getByRole("button", { name: photo })).toBeVisible();
    expect(api.paths[0], "the wrapping is fetched again, first").toBe("/v1/recipient/key");

    const dump = await dumpStorage(page);
    expect(dump.sessionStorage[INVITE_ENTRY], "the tab kept exactly the fragment").toBe(f.qrFragment);
    expect(storageViolations(dump, [...f.inviteSecrets, f.qr.token], { recipientInvite: f.qrFragment })).toEqual([]);
    expect(await violations()).toEqual([]);
  });

  test("a passphrase invite: reload, and the words are asked for again — and still open it", async ({ page, context, baseURL }) => {
    const violations = await watch(page);
    await relay(context, f, new URL(baseURL ?? "").origin);

    await page.goto(`/v/${f.passFragment}`);
    await expect(page.getByRole("heading", { name: en["recipient.passphrase.title"] })).toBeVisible();
    await page.reload();
    await page.waitForLoadState("load");
    expect(new URL(page.url()).hash).toBe("");
    await expect(page.getByRole("heading", { name: en["recipient.passphrase.title"] })).toBeVisible();

    for (const [i, word] of WORDS.entries()) await page.getByLabel(en["recipient.passphrase.word"](i + 1)).fill(word);
    await page.getByRole("button", { name: en["recipient.passphrase.submit"] }).click();
    await expect(page.getByRole("button", { name: en["onboarding.continue"] })).toBeVisible({ timeout: 30_000 });

    const dump = await dumpStorage(page);
    expect(dump.sessionStorage[INVITE_ENTRY]).toBe(f.passFragment);
    expect(storageViolations(dump, [f.pass.token, ...WORDS], { recipientInvite: f.passFragment })).toEqual([]);
    expect(await violations()).toEqual([]);
  });

  test("revoke, reload: the revoked screen, the entry cleared, and a further reload is the dead page", async ({ page, context, baseURL }) => {
    const violations = await watch(page);
    await relay(context, f, new URL(baseURL ?? "").origin);

    // Onboarding starts the album request (flows §4.4) and may show before it is answered. Flipped
    // while it is in flight, the old page hears the 403 first, forgets the invite as flows §4.6
    // says, and the reload finds nothing: the dead page, not the revoked one. Seen 2 in 20.
    const albumAnswered = page.waitForResponse((r) => new URL(r.url()).pathname === `/v1/albums/${f.albumId}`);
    await page.goto(`/v/${f.qrFragment}`);
    await expect(page.getByRole("button", { name: en["onboarding.continue"] })).toBeVisible();
    await albumAnswered;

    f.qr.revoked = true;
    await page.reload();
    await text(en.revoked)(page);
    const dump = await dumpStorage(page);
    expect(dump.sessionStorage[INVITE_ENTRY], "revoked clears the entry").toBeUndefined();
    expect(storageViolations(dump, [...f.inviteSecrets, f.qr.token])).toEqual([]);

    await page.reload();
    await text(en.dead)(page);
    expect(await violations()).toEqual([]);
  });
});

test.describe("the recipient's path on a device set to Spanish (brief §15, §16)", () => {
  test.use({ locale: "es-ES" });
  let f: Fixtures;
  test.beforeAll(async () => {
    f = await fixtures();
  });

  test("onboarding is §16's Spanish text, the grid is Spanish, a switch holds for the visit, and a reload starts in Spanish again", async ({ page, context, baseURL }) => {
    const violations = await watch(page);
    await relay(context, f, new URL(baseURL ?? "").origin);
    const choice = (name: string) => page.locator("[data-language-switch]").first().getByRole("button", { name, exact: true });

    await page.goto(`/v/${f.qrFragment}`);
    for (const paragraph of es["onboarding.text"]) await expect(page.getByText(paragraph, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("es");
    await page.getByRole("button", { name: es["onboarding.continue"] }).click();
    await expect(page.getByRole("button", { name: es["grid.photo.a11y"](1, 1) })).toBeVisible();

    await choice(autonym("en")).click();
    await expect(page.getByRole("button", { name: en["grid.photo.a11y"](1, 1) })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("en");

    await page.reload();
    await page.waitForLoadState("load");
    await expect(page.getByRole("button", { name: es["onboarding.continue"] })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.lang)).toBe("es");

    const dump = await dumpStorage(page);
    expect(dump.sessionStorage[INVITE_ENTRY]).toBe(f.qrFragment);
    expect(storageViolations(dump, [...f.inviteSecrets, f.qr.token], { recipientInvite: f.qrFragment }), "nothing but the one permitted entry").toEqual([]);
    expect(await violations()).toEqual([]);
  });
});
