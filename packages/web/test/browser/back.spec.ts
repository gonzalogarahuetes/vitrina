/*
 * The browser's Back follows the app's screens (lib/history.ts), in a real
 * browser against the production build: the owner against the fake relay
 * (relay.ts), the recipient against recipient-fixtures.ts.
 *
 *   1. Owner: every level and every sheet, Back up to the top, out of the app
 *      and in again.
 *      The guards: an upload in flight and the invite's share step ask and
 *      stay; confirmed on screen, they leave. Twenty viewer opens and closes
 *      with the on-screen control, then one Back from the album, lands on the
 *      list. Then sign-out, and Back reopens nothing.
 *   2. Owner: a reload on the viewer starts at unlock; unlock's sign-out
 *      sheet closes on Back and unlock stays; Back again leaves the app.
 *   3. Recipient, QR and passphrase: grid → viewer → Back → grid; twenty
 *      opens and closes; Back leaves the app.
 *   4. Recipient: a reload on the viewer, then Back until the app is left.
 *
 * After every step: the address has no fragment and its path never changed;
 * history.state holds SvelteKit's keys and at most `vitrina:depth` from
 * {1, 2, 3}, matching the screen (an allowlist, not a search); and the storage
 * dump, history.state included, passes test/storage-allowlist.ts with this
 * test's secrets searched for everywhere.
 *
 * "Leaving the app" is Back landing on a page outside it, opened first.
 */
import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { storageViolations } from "../storage-allowlist.ts";
import { dumpStorage, watch } from "./helpers.ts";
import { WORDS, fixtures, relay as recipientRelay, type Fixtures } from "./recipient-fixtures.ts";
import { fakeRelay } from "./relay.ts";

const EMAIL = "parent@example.com";
const PASSWORD = "copper kettle under the stairs 47";
const ARGON = 60_000;
const ALBUM_TITLE = "Verano 2026";
const LABEL = "María Fernández";
const OUTSIDE = "http://outside.test/";

type Relay = ReturnType<typeof fakeRelay>;

// ── The checks after every step ─────────────────────────────────────────────

const SVELTEKIT_KEYS = new Set(["sveltekit:history", "sveltekit:navigation"]);

/** The allowlist: SvelteKit's numeric indices and empty states, and the marker from the fixed set. Anything else is a finding. */
function historyStateFindings(state: unknown): string[] {
  if (state === null || state === undefined) return [];
  if (typeof state !== "object" || Array.isArray(state)) return ["history.state is not an object"];
  return Object.entries(state).flatMap(([k, v]) => {
    if (k === "vitrina:depth") return [1, 2, 3].includes(v as number) ? [] : ["vitrina:depth outside {1, 2, 3}"];
    if (SVELTEKIT_KEYS.has(k)) return typeof v === "number" ? [] : [`${k} is not a number`];
    // SvelteKit's shallow-routing states: always empty here, since nothing calls its pushState.
    if (k === "sveltekit:states") return typeof v === "object" && v !== null && Object.keys(v).length === 0 ? [] : ["sveltekit:states is not empty"];
    return [`history.state holds a key that is not permitted: ${JSON.stringify(k).slice(0, 30)}`];
  });
}

type Check = { path: string; secrets: () => string[]; owner?: boolean; recipientInvite?: string };

/** The URL, history.state and storage, and the depth the screen should sit at. */
async function settled(page: Page, c: Check, depth: number, what: string): Promise<void> {
  // History is moved to the screen's depth by a go(), which lands a task later.
  const marker = () => page.evaluate(() => ((history.state as Record<string, unknown> | null)?.["vitrina:depth"] ?? 0) as unknown);
  await expect.poll(marker, { message: `${what}: history's depth` }).toBe(depth);
  const where = await page.evaluate(() => ({ hash: location.hash, path: location.pathname, search: location.search, state: history.state as unknown }));
  expect(where.hash, `${what}: no fragment`).toBe("");
  expect(where.search, `${what}: no query`).toBe("");
  expect(where.path, `${what}: the path never changes`).toBe(c.path);
  expect(historyStateFindings(where.state), `${what}: history.state`).toEqual([]);
  expect(storageViolations(await dumpStorage(page), c.secrets(), { owner: c.owner === true, recipientInvite: c.recipientInvite }), `${what}: storage`).toEqual([]);
}

/** Back, as the browser's button. Same-document entries fire popstate and nothing loads. */
async function back(page: Page): Promise<void> {
  await page.goBack({ waitUntil: "commit" });
}

async function leftTheApp(page: Page): Promise<void> {
  await expect.poll(() => page.url(), { message: "Back left the app" }).toBe(OUTSIDE);
}

/** A page outside the app, opened first, so Back from the app's top lands somewhere. */
async function startOutside(page: Page): Promise<void> {
  await page.route(OUTSIDE, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>outside</title><p>outside</p>" }));
  await page.goto(OUTSIDE);
}

/**
 * Reloads, and counts every document load that follows until the screen has
 * settled and a little longer: a start-up that traversed onto an entry from
 * before the reload would load the app a second time.
 */
async function reloadCountingLoads(page: Page, settle: () => Promise<void>): Promise<number> {
  let loads = 0;
  const count = (): void => void loads++;
  page.on("load", count);
  await page.reload();
  await settle();
  await page.waitForTimeout(1000);
  page.off("load", count);
  // The document on screen is the reload's own, not one a traversal loaded afterwards.
  const type = await page.evaluate(() => (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type);
  expect(type, "the document on screen came from the reload").toBe("reload");
  return loads;
}

const opened: BrowserContext[] = [];
test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((c) => c.close()));
});

async function newContext(browser: Browser): Promise<BrowserContext> {
  const ctx = await browser.newContext();
  opened.push(ctx);
  return ctx;
}

// ── The owner ──────────────────────────────────────────────────────────────

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

const heading = (page: Page, name: string) => page.getByRole("heading", { name, exact: true });
const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true });

/** Signed up, on the album list, with an outside page behind the app. */
async function ownerOnList(browser: Browser, relay: Relay) {
  const ctx = await newContext(browser);
  await relay.attach(ctx);
  const page = await ctx.newPage();
  const violations = await watch(page);
  await startOutside(page);
  await page.goto("/");
  await button(page, en["signin.to-signup"]).click();
  await page.getByLabel(en["signup.email.label"]).fill(EMAIL);
  await page.getByLabel(en["signup.password.label"]).fill(PASSWORD);
  await button(page, en["signup.submit"]).click();
  await expect(heading(page, en["albums.title"])).toBeVisible({ timeout: ARGON });
  const albumId = () => (JSON.parse(relay.log.find((r) => r.method === "POST" && r.path === "/v1/albums")?.body ?? "{}") as { id?: string }).id ?? "";
  const c: Check = {
    path: "/",
    owner: true,
    // What must never be in history or storage: ids, the title, the invite's label, token and key, once they exist.
    secrets: () => [albumId(), ...relay.media.keys(), ALBUM_TITLE, LABEL, ...[...relay.recipients.keys()], ...inviteSecrets].filter((s) => s !== ""),
  };
  const inviteSecrets: string[] = [];
  return { ctx, page, violations, c, inviteSecrets, albumId };
}

async function createAndOpenAlbum(page: Page, c: Check): Promise<void> {
  await button(page, en["album.create"]).click();
  await page.getByLabel(en["album.title.label"]).fill(ALBUM_TITLE);
  await button(page, en["album.create.submit"]).click();
  await expect(page.getByLabel(en["album.title.label"])).toBeHidden();
  await settled(page, c, 0, "album created");
  await button(page, en["albums.open.a11y"](ALBUM_TITLE)).click();
  await expect(heading(page, ALBUM_TITLE)).toBeVisible();
  await settled(page, c, 1, "album");
}

async function choose(page: Page, n: number): Promise<void> {
  await page.locator("#add-photos").setInputFiles([{ name: `photo-${n}.jpg`, mimeType: "image/jpeg", buffer: await canvasJpeg(page, 1200, 900) }]);
  await expect(button(page, en["upload.review.send"](1))).toBeVisible();
}

test("owner: every level and sheet, Back to the top and out; the guards; twenty viewer opens; sign-out", async ({ browser }) => {
  test.setTimeout(300_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { page, violations, c, inviteSecrets } = await ownerOnList(browser, relay);
  await settled(page, c, 0, "album list");

  // The create sheet closes on Back.
  await button(page, en["album.create"]).click();
  await expect(page.getByLabel(en["album.title.label"])).toBeVisible();
  await settled(page, c, 1, "create sheet");
  await back(page);
  await expect(page.getByLabel(en["album.title.label"])).toBeHidden();
  await settled(page, c, 0, "create sheet, Back");

  await createAndOpenAlbum(page, c);

  // The review step: Back is its Cancel.
  await choose(page, 1);
  await settled(page, c, 2, "review");
  await back(page);
  await expect(button(page, en["upload.review.send"](1))).toBeHidden();
  await expect(heading(page, ALBUM_TITLE)).toBeVisible();
  await settled(page, c, 1, "review, Back");

  // A photo, sent and ready.
  await choose(page, 1);
  await button(page, en["upload.review.send"](1)).click();
  const cell = button(page, en["album.photo.a11y"](1, 1));
  await expect(cell).toBeVisible({ timeout: 60_000 });
  await settled(page, c, 1, "album with a photo");

  // The viewer.
  await cell.click();
  await expect(button(page, en["viewer.back"])).toBeVisible();
  await settled(page, c, 2, "viewer");
  await back(page);
  await expect(button(page, en["viewer.back"])).toBeHidden();
  await settled(page, c, 1, "viewer, Back");

  // Depth, not a growing stack: twenty opens and closes with the viewer's own control.
  const length = await page.evaluate(() => history.length);
  for (let i = 0; i < 20; i++) {
    await cell.click();
    await expect(button(page, en["viewer.back"])).toBeVisible();
    await button(page, en["viewer.back"]).click();
    await expect(button(page, en["viewer.back"])).toBeHidden();
  }
  await settled(page, c, 1, "after twenty viewer opens");
  expect(await page.evaluate(() => history.length), "history did not grow").toBeLessThanOrEqual(length);
  await back(page);
  await expect(heading(page, en["albums.title"])).toBeVisible();
  await settled(page, c, 0, "one Back from the album after twenty viewer opens");
  await button(page, en["albums.open.a11y"](ALBUM_TITLE)).click();
  await expect(cell).toBeVisible();
  await settled(page, c, 1, "album again");

  // The remove sheet closes on Back, as Keep it does.
  await button(page, en["media.remove"]).click();
  await expect(page.getByRole("alertdialog")).toContainText(en["remove.title"]);
  await settled(page, c, 2, "remove sheet");
  await back(page);
  await expect(page.getByRole("alertdialog")).toBeHidden();
  expect(relay.media.size, "nothing was removed").toBe(1);
  await settled(page, c, 1, "remove sheet, Back");

  // The invite form: Back to the album.
  await button(page, en["album.invite"]).click();
  await expect(heading(page, en["invite.title"])).toBeVisible();
  await settled(page, c, 2, "invite form");
  await back(page);
  await expect(heading(page, ALBUM_TITLE)).toBeVisible();
  await settled(page, c, 1, "invite form, Back");

  // The share step asks first: Back asks and stays; Back is Stay; confirmed, it leaves.
  await button(page, en["album.invite"]).click();
  await page.getByLabel(en["invite.name.label"]).fill(LABEL);
  await button(page, en["invite.create"]).click();
  await expect(heading(page, en["invite.share.title"](LABEL))).toBeVisible({ timeout: ARGON });
  const link = (await page.locator("[data-invite-link]").textContent()) ?? "";
  const fragment = new URLSearchParams(link.slice(link.indexOf("#") + 1));
  inviteSecrets.push(link.slice(link.indexOf("#")), fragment.get("t") ?? "", fragment.get("k") ?? "");
  await settled(page, c, 2, "share step");
  await back(page);
  await expect(page.getByRole("alertdialog")).toContainText(en["invite.leave.consequence"]);
  await expect(page.locator("[data-invite-link]")).toHaveText(link);
  await settled(page, c, 3, "share step, Back: asks");
  await back(page);
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(heading(page, en["invite.share.title"](LABEL))).toBeVisible();
  await settled(page, c, 2, "share step, Back again: stays");
  await back(page);
  await expect(page.getByRole("alertdialog")).toContainText(en["invite.leave.consequence"]);
  await settled(page, c, 3, "share step, Back: asks again");
  await button(page, en["invite.leave.confirm"]).click();
  await expect(heading(page, ALBUM_TITLE)).toBeVisible();
  await settled(page, c, 1, "share step left");

  // People → revoke sheet → access log, and back up.
  await button(page, en["album.people"]).click();
  await expect(heading(page, en["people.title"])).toBeVisible();
  await settled(page, c, 2, "people");
  await page.locator("li.person").getByRole("button", { name: en["people.revoke"] }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await settled(page, c, 3, "revoke sheet");
  await back(page);
  await expect(page.getByRole("alertdialog")).toBeHidden();
  expect([...relay.recipients.values()][0]?.revoked_at, "nothing was revoked").toBeNull();
  await settled(page, c, 2, "revoke sheet, Back");
  await button(page, en["people.log"]).click();
  await expect(button(page, en["log.back"])).toBeVisible();
  await settled(page, c, 3, "access log");
  await back(page);
  await expect(heading(page, en["people.title"])).toBeVisible();
  await settled(page, c, 2, "access log, Back");
  await back(page);
  await expect(heading(page, ALBUM_TITLE)).toBeVisible();
  await settled(page, c, 1, "people, Back");

  // An upload in flight: Back asks and stays; Back is Stay; Leave anyway leaves.
  const release = relay.holdReady();
  await choose(page, 2);
  await button(page, en["upload.review.send"](1)).click();
  await expect(page.getByText(en["upload.waiting"])).toBeVisible({ timeout: 30_000 });
  await settled(page, c, 1, "upload in flight");
  await back(page);
  await expect(page.getByRole("alertdialog")).toContainText(en["album.leaving"]);
  await settled(page, c, 2, "upload in flight, Back: asks");
  await back(page);
  await expect(page.getByRole("alertdialog")).toBeHidden();
  await expect(page.getByText(en["upload.waiting"])).toBeVisible();
  await settled(page, c, 1, "upload in flight, Back again: stays");
  await back(page);
  await expect(page.getByRole("alertdialog")).toContainText(en["album.leaving"]);
  await settled(page, c, 2, "upload in flight, Back: asks again");
  await button(page, en["album.leaving.go"]).click();
  await expect(heading(page, en["albums.title"])).toBeVisible();
  release();
  await settled(page, c, 0, "upload left");

  // The top: Back leaves the app. Forward comes back to the page as the browser kept it, or to a fresh load at unlock.
  await back(page);
  await leftTheApp(page);
  await page.goForward();
  const list = heading(page, en["albums.title"]);
  const unlock = heading(page, en["unlock.prompt"]);
  await expect(list.or(unlock)).toBeVisible();
  await expect(heading(page, ALBUM_TITLE)).toBeHidden();
  await settled(page, c, 0, "Forward into the app again");
  if (await unlock.isVisible()) {
    await page.locator("#unlock-password").fill(PASSWORD);
    await button(page, en["unlock.submit"]).click();
    await expect(list).toBeVisible({ timeout: ARGON });
    await settled(page, c, 0, "unlocked again");
  }

  // Sign-out: Back leaves the app, and nothing from before comes back.
  await button(page, en["logout.device"]).click();
  await expect(page.getByRole("heading", { name: en["signin.title"] })).toBeVisible();
  await settled(page, c, 0, "signed out");
  await back(page);
  await leftTheApp(page);
  await page.goForward();
  await expect(page.getByRole("heading", { name: en["signin.title"] })).toBeVisible();
  await expect(heading(page, ALBUM_TITLE)).toBeHidden();
  await settled(page, c, 0, "signed out, Back, Forward");
  for (let i = 0; i < 3; i++) {
    await page.goForward().catch(() => null);
    await expect(page.getByRole("heading", { name: en["signin.title"] })).toBeVisible();
  }
  await settled(page, c, 0, "signed out, Forward again");
  await back(page);
  await leftTheApp(page);
  expect(await violations(), "CSP violations and page errors").toEqual([]);
});

test("owner: a reload on the viewer starts at unlock; its sign-out sheet closes on Back; Back again leaves the app", async ({ browser }) => {
  test.setTimeout(240_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const { page, violations, c } = await ownerOnList(browser, relay);
  await createAndOpenAlbum(page, c);
  await choose(page, 1);
  await button(page, en["upload.review.send"](1)).click();
  const cell = button(page, en["album.photo.a11y"](1, 1));
  await expect(cell).toBeVisible({ timeout: 60_000 });
  await cell.click();
  await expect(button(page, en["viewer.back"])).toBeVisible();
  await settled(page, c, 2, "viewer");

  const loads = await reloadCountingLoads(page, async () => {
    await expect(heading(page, en["unlock.prompt"])).toBeVisible();
    await settled(page, c, 0, "reloaded: unlock, at the top");
  });
  expect(loads, "the reload loaded the page exactly once").toBe(1);

  await button(page, en["unlock.signout"]).click();
  await expect(page.getByRole("dialog")).toContainText(en["unlock.signout.confirm"]);
  await settled(page, c, 1, "unlock's sign-out sheet");
  await back(page);
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(heading(page, en["unlock.prompt"])).toBeVisible();
  await settled(page, c, 0, "sheet, Back: unlock stays");
  expect(relay.log.some((r) => r.path.startsWith("/v1/logout")), "nothing was signed out").toBe(false);
  await back(page);
  await leftTheApp(page);
  expect(await violations(), "CSP violations and page errors").toEqual([]);
});

// ── The recipient ──────────────────────────────────────────────────────────

test.describe("recipient", () => {
  let f: Fixtures;
  test.beforeAll(async () => {
    f = await fixtures();
  });

  const photo = en["grid.photo.a11y"](1, 1);

  async function open(page: Page, context: BrowserContext, baseURL: string | undefined, kind: "qr" | "passphrase"): Promise<Check> {
    await recipientRelay(context, f, new URL(baseURL ?? "").origin);
    await startOutside(page);
    const fragment = kind === "qr" ? f.qrFragment : f.passFragment;
    await page.goto(`/v/${fragment}`);
    const c: Check = {
      path: "/v/",
      recipientInvite: fragment,
      secrets: () => [...f.inviteSecrets, f.qr.token, f.pass.token, f.albumId, f.mediaId, ...WORDS],
    };
    if (kind === "passphrase") {
      for (const [i, word] of WORDS.entries()) await page.getByLabel(en["recipient.passphrase.word"](i + 1)).fill(word);
      await settled(page, c, 0, "passphrase");
      await page.getByRole("button", { name: en["recipient.passphrase.submit"] }).click();
    }
    await expect(page.getByRole("button", { name: en["onboarding.continue"] })).toBeVisible({ timeout: ARGON });
    await settled(page, c, 0, "onboarding");
    await page.getByRole("button", { name: en["onboarding.continue"] }).click();
    await expect(page.getByRole("button", { name: photo })).toBeVisible();
    await settled(page, c, 0, "grid");
    return c;
  }

  async function viewer(page: Page): Promise<void> {
    await page.getByRole("button", { name: photo }).click();
    await expect(page.getByRole("button", { name: en["viewer.back"] })).toBeVisible();
  }

  for (const kind of ["qr", "passphrase"] as const) {
    test(`${kind}: grid → viewer, Back to the grid; twenty opens and closes; Back leaves the app`, async ({ page, context, baseURL }) => {
      const violations = await watch(page);
      const c = await open(page, context, baseURL, kind);
      await viewer(page);
      await settled(page, c, 1, "viewer");
      await back(page);
      await expect(page.getByRole("button", { name: en["viewer.back"] })).toBeHidden();
      await settled(page, c, 0, "viewer, Back");

      const length = await page.evaluate(() => history.length);
      for (let i = 0; i < 20; i++) {
        await viewer(page);
        await page.getByRole("button", { name: en["viewer.back"] }).click();
        await expect(page.getByRole("button", { name: en["viewer.back"] })).toBeHidden();
      }
      await settled(page, c, 0, "after twenty viewer opens");
      expect(await page.evaluate(() => history.length), "history did not grow").toBeLessThanOrEqual(length + 1);
      await back(page);
      await leftTheApp(page);
      expect(await violations()).toEqual([]);
    });
  }

  test("a reload on the viewer, then Back until the app is left", async ({ page, context, baseURL }) => {
    const violations = await watch(page);
    const c = await open(page, context, baseURL, "qr");
    await viewer(page);
    await settled(page, c, 1, "viewer");
    const loads = await reloadCountingLoads(page, async () => {
      await expect(page.getByRole("button", { name: en["onboarding.continue"] })).toBeVisible();
      await settled(page, c, 0, "reloaded: onboarding, at the top");
    });
    expect(loads, "the reload loaded the page exactly once").toBe(1);
    await page.getByRole("button", { name: en["onboarding.continue"] }).click();
    await expect(page.getByRole("button", { name: photo })).toBeVisible();
    await settled(page, c, 0, "reloaded: grid");
    await page.goForward({ waitUntil: "commit" }).catch(() => null);
    await expect(page.getByRole("button", { name: photo })).toBeVisible();
    await expect(page.getByRole("button", { name: en["viewer.back"] })).toBeHidden();
    await settled(page, c, 0, "Forward reopens nothing");
    await back(page);
    await leftTheApp(page);
    expect(await violations()).toEqual([]);
  });

  test("the load count notices a second load after the reload (the check, broken on purpose)", async ({ page, context, baseURL }) => {
    const c = await open(page, context, baseURL, "qr");
    await viewer(page);
    let forced = false;
    const loads = await reloadCountingLoads(page, async () => {
      await expect(page.getByRole("button", { name: en["onboarding.continue"] })).toBeVisible();
      if (!forced) {
        forced = true;
        // What a start-up traversing onto a pre-reload document would cost: the app loaded again.
        await page.evaluate(() => location.reload());
        await expect(page.getByRole("button", { name: en["onboarding.continue"] })).toBeVisible();
      }
      await settled(page, c, 0, "reloaded twice");
    });
    expect(loads).toBe(2);
  });
});
