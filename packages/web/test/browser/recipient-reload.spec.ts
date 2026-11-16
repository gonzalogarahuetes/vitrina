/*
 * Flows §4.7 in a real browser: a reload of the same tab continues, from the
 * fragment the tab kept in sessionStorage (lib/session/recipient-session.ts).
 * The production build, the real WASM, the owner's real openInviteKey and
 * openPassphraseKey, and a faked API (recipient-fixtures.ts, behind
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
import { expect, test } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { es } from "../../src/lib/copy/es.ts";
import { autonym } from "../../src/lib/copy/format.ts";
import { storageViolations } from "../storage-allowlist.ts";
import { dumpStorage, text, watch } from "./helpers.ts";
import { WORDS, fixtures, relay, type Fixtures } from "./recipient-fixtures.ts";

const INVITE_ENTRY = "vitrina:recipient:invite";

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
