/*
 * The production build in a real browser (Chromium, and WebKit as the closest
 * CI gets to iPhone Safari, still an approximation). Four pages, none needing
 * the API: the three static screens, and a QR and a passphrase invite while
 * every API request fails, so the app sits in its offline state.
 *
 *   1. No CSP violation, ever: every `securitypolicyviolation` event, every
 *      console message naming the Content Security Policy, and every uncaught
 *      page error fails the page. check-build reads the policy; only a browser
 *      shows what it blocks.
 *
 *      CHROMIUM IS THE CSP AUTHORITY. WebKit does not report a blocked `style`
 *      attribute parsed from template markup, which is how Svelte renders and
 *      how SvelteKit's announcer slipped through (confirmed by the owner, with
 *      the announcer fix removed: every Chromium page failed, no WebKit page
 *      did). WebKit still runs the same assertion and catches what it reports,
 *      but a green WebKit run says nothing about CSP. Its value here is the
 *      storage check and the key-in-memory page.
 *   2. Storage after a reload (invite spec §7 item 7, in a real browser): the
 *      reload runs SvelteKit's persist_state(), then everything persistent is
 *      read and judged by test/storage-allowlist.ts. Permitted: sveltekit:scroll
 *      (numbers only), an empty sveltekit:snapshot, and on an invite page
 *      vitrina:recipient:invite holding exactly that invite's fragment (flows
 *      §4.7). Nothing else, and none of the invite's secrets — K_invite in
 *      every spelling, the token — anywhere but that one entry.
 *
 * The last tests break each check on purpose and expect it to notice, so every
 * run proves the detectors still work. The CSP ones run in Chromium only, for
 * the reason above.
 *
 * The recipient routes, and the owner's sign-in screen as `/` first shows it
 * with no token. The owner path, with a faked API and its own allowlist, is
 * owner.spec.ts. The full grid-and-viewer path, with a faked API, is a later step.
 */
import { expect, test, type Page } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { storageViolations, type StorageDump } from "../storage-allowlist.ts";
import { apiOrigin, blocklistChunk, cutTheApi, dumpStorage, text, watch } from "./helpers.ts";

/** A QR invite with fixed values: canonical base64url, as the owner's client writes it. */
const b64url = (bytes: Buffer) => bytes.toString("base64url");
const ALBUM = Buffer.alloc(16, 0x11);
const TOKEN = Buffer.alloc(32, 0x22);
/** K_invite (encryption spec §6.1): the fragment's `k`. */
const INVITE_KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const QR_FRAGMENT = `v=1&a=${b64url(ALBUM)}&t=${b64url(TOKEN)}&k=${b64url(INVITE_KEY)}`;
const PASS_FRAGMENT = `v=1&a=${b64url(ALBUM)}&t=${b64url(TOKEN)}`;

/** Every spelling of the invite's secrets that could end up stored: K_invite, then the token. */
const SECRETS = [
  QR_FRAGMENT,
  b64url(INVITE_KEY),
  INVITE_KEY.toString("base64"),
  INVITE_KEY.toString("hex"),
  INVITE_KEY.toString("hex").toUpperCase(),
  JSON.stringify(Array.from(INVITE_KEY)),
  Array.from(INVITE_KEY).join(","),
  b64url(TOKEN),
];

type Visit = {
  readonly name: string;
  readonly path: string;
  readonly ready: (page: Page) => Promise<void>;
  readonly secrets: readonly string[];
  /** After the reload, also navigate to `/` and back: SvelteKit persists again on leaving. */
  readonly roundTrip?: boolean;
  /** The fragment flows §4.7 lets this page keep, under vitrina:recipient:invite. */
  readonly invite?: string;
};

const PAGES: readonly Visit[] = [
  // No token, so the owner's sign-in screen, and no request at all.
  { name: "root (owner sign-in)", path: "/", ready: async (page) => expect(page.getByRole("heading", { name: en["signin.title"] })).toBeVisible(), secrets: [] },
  { name: "dead page", path: "/v/", ready: text(en.dead), secrets: [] },
  { name: "newer version", path: "/v/#v=2&x=y", ready: text(en["open.newer-version"]), secrets: ["v=2&x=y"] },
  // The fragment is kept for the tab; the first request (/recipient/key) fails, so the app waits offline.
  {
    name: "QR invite, API unreachable",
    path: `/v/#${QR_FRAGMENT}`,
    ready: text(en.offline),
    secrets: SECRETS,
    roundTrip: true,
    invite: `#${QR_FRAGMENT}`,
  },
  {
    name: "passphrase invite, API unreachable",
    path: `/v/#${PASS_FRAGMENT}`,
    ready: text(en.offline),
    secrets: [PASS_FRAGMENT, b64url(TOKEN)],
    invite: `#${PASS_FRAGMENT}`,
  },
];

/**
 * Load, reload once (and, for the key page, go to `/` and back), then read
 * storage. Each unload is a point where SvelteKit writes sessionStorage.
 */
async function visitAndReload(page: Page, visit: Visit): Promise<StorageDump> {
  await page.goto(visit.path);
  await visit.ready(page);
  await page.reload();
  await page.waitForLoadState("load");
  // An invite page restores from the tab and requests /recipient/key again
  // (flows §4.7). Wait until that request has failed and the page has settled:
  // leaving with it still in flight lets navigation cancel it before
  // cutTheApi's handler sees it, and WebKit reports that cancellation as an
  // access-control error the test did not cause. Pages that keep nothing
  // make no request after a reload, and the newer-version page comes back
  // dead (its fragment was never kept), so only invite pages wait here.
  if (visit.invite !== undefined) await visit.ready(page);
  if (visit.roundTrip === true) {
    await page.goto("/");
    await page.goBack();
    await page.waitForLoadState("load");
    // The fragment was stripped, but the tab kept it (flows §4.7): /v/ comes back to the invite, offline again.
    await visit.ready(page);
  }
  return dumpStorage(page);
}

for (const visit of PAGES) {
  test(`${visit.name}: no CSP violation, and storage holds only what is permitted after a reload`, async ({ page, context }) => {
    const aborted = new Set<string>();
    const violations = await watch(page, { aborted });
    const chunk = blocklistChunk();
    const blocklistLoads: string[] = [];
    const apiFromRoot: string[] = [];
    const api = apiOrigin();
    page.on("request", (r) => {
      if (r.url().endsWith(chunk)) blocklistLoads.push(r.url());
      // `/` is the owner app. With no token it must make no API request at
      // all, on a direct visit or on the QR page's round trip through it.
      if (new URL(r.url()).origin === api && new URL(r.frame().url()).pathname === "/") apiFromRoot.push(r.url());
    });
    await cutTheApi(page, aborted);
    const dump = await visitAndReload(page, visit);
    const cookies = await context.cookies();

    // Only signup loads the password blocklist; none of these pages is signup.
    expect(blocklistLoads, "requests for the blocklist chunk").toEqual([]);
    expect(apiFromRoot, "API requests from / with no token").toEqual([]);

    expect(await violations(), "CSP violations").toEqual([]);
    expect(storageViolations(dump, visit.secrets, { recipientInvite: visit.invite }), "storage").toEqual([]);
    if (visit.invite !== undefined) expect(dump.sessionStorage["vitrina:recipient:invite"], "the kept fragment").toBe(visit.invite);
    expect(cookies, "cookies").toEqual([]);
  });
}

/*
 * SvelteKit asks _app/version.json whether a redeploy explains a failed route
 * load (@sveltejs/kit client.js, load_route's catch and navigate's error-page
 * branch). connect-src refuses it, so vite-plugins.ts's noVersionCheck() stops
 * the request. In the wild this happened only in WebKit, only sometimes: a
 * navigation away cancelled a pending route import. Here the route's own
 * chunk is refused outright, so the same code path runs every time, in both
 * browsers. Chunks 0 and 1 are SvelteKit's root layout and root error page,
 * loaded eagerly; 2 and up are routes.
 */
test("a route that fails to load makes no request the CSP refuses (SvelteKit's version check)", async ({ page }) => {
  const violations = await watch(page);
  const asked: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("version.json")) asked.push(r.url());
  });
  await cutTheApi(page);
  await page.route(/\/_app\/immutable\/nodes\/([2-9]|\d{2,})\.[^/]+\.js$/, (route) => route.abort("failed"));
  await page.goto("/v/");
  // SvelteKit gives up on the route and renders its root error page.
  await expect(page.getByRole("heading", { name: "500" })).toBeVisible();
  await page.waitForTimeout(250); // let any violation event reach the binding
  expect(await violations(), "CSP violations").toEqual([]);
  expect(asked, "requests for version.json").toEqual([]);
});

// ── The checks, broken on purpose ─────────────────────────────────────────

const CSP_AUTHORITY = "chromium";
const NOT_AUTHORITY = "WebKit does not report blocked style attributes from template markup; Chromium is the CSP authority";

test("the CSP check notices a style attribute parsed from template markup, as Svelte renders it", async ({ page, browserName }) => {
  test.skip(browserName !== CSP_AUTHORITY, NOT_AUTHORITY);
  const violations = await watch(page);
  // Svelte's path (create_fragment_from_html, then a clone inserted into the
  // document): the one the announcer took before vite-plugins.ts removed it.
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const template = document.createElement("template");
      template.innerHTML = '<div style="position: absolute">canary</div>';
      document.body.append(template.content.cloneNode(true));
    });
  });
  await page.goto("/v/");
  await text(en.dead)(page);
  await expect.poll(violations).not.toEqual([]);
  expect((await violations()).join("\n")).toMatch(/style/i);
});

test("the CSP check notices a style attribute set at runtime", async ({ page, browserName }) => {
  test.skip(browserName !== CSP_AUTHORITY, NOT_AUTHORITY);
  const violations = await watch(page);
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => document.body.setAttribute("style", "color: red"));
  });
  await page.goto("/v/");
  await text(en.dead)(page);
  await expect.poll(violations).not.toEqual([]);
  expect((await violations()).join("\n")).toMatch(/style/i);
});

test("the storage check notices an extra sessionStorage key written on load", async ({ page }) => {
  await page.addInitScript(() => {
    sessionStorage.setItem("vitrina:canary", "written on load");
  });
  const dump = await visitAndReload(page, PAGES[1] as Visit);
  expect(storageViolations(dump)).toEqual(['sessionStorage key "vitrina:canary" is not permitted']);
});

test("the secret search notices the fragment's k written to window.name on load", async ({ page }) => {
  const qr = PAGES[3] as Visit;
  await cutTheApi(page);
  await page.addInitScript((k) => {
    window.name = k;
  }, b64url(INVITE_KEY));
  const dump = await visitAndReload(page, qr);
  const found = storageViolations(dump, qr.secrets, { recipientInvite: qr.invite });
  // Exactly one finding, naming window.name. Which secret numbers it lists
  // depends on which spellings of k coincide, so they are computed, not fixed.
  const k = b64url(INVITE_KEY);
  const hits = qr.secrets.flatMap((secret, i) => (k.includes(secret) ? [`#${i}`] : []));
  expect(found).toEqual([`window.name holds secret ${hits.join(", ")}`]);
  expect(found.join(" ")).not.toContain(k);
});

test("the secret search notices K_invite written under a second sessionStorage key, beside the permitted one", async ({ page }) => {
  const qr = PAGES[3] as Visit;
  await cutTheApi(page);
  await page.addInitScript((k) => {
    sessionStorage.setItem("vitrina:canary", k);
  }, b64url(INVITE_KEY));
  const dump = await visitAndReload(page, qr);
  const found = storageViolations(dump, qr.secrets, { recipientInvite: qr.invite });
  const k = b64url(INVITE_KEY);
  const hits = qr.secrets.flatMap((secret, i) => (k.includes(secret) ? [`#${i}`] : []));
  expect(found).toEqual([`sessionStorage key "vitrina:canary" holds secret ${hits.join(", ")}`]);
  expect(found.join(" ")).not.toContain(k);
});

// ── The WebKit abort tolerance, broken on purpose (abort-report.ts) ────────

/** Throws `message` uncaught, once, on the round trip's visit to `/`. */
async function throwOnRoot(page: Page, message: string, type: "Error" | "TypeError"): Promise<void> {
  await page.addInitScript(
    ([m, t]) => {
      if (location.pathname !== "/") return;
      setTimeout(() => {
        throw t === "TypeError" ? new TypeError(m) : new Error(m);
      }, 0);
    },
    [message, type] as const,
  );
}

const QR = () => PAGES[3] as Visit;

test("a genuine uncaught error on the round trip through / still fails, in both browsers", async ({ page }) => {
  const aborted = new Set<string>();
  const violations = await watch(page, { aborted });
  await cutTheApi(page, aborted);
  await throwOnRoot(page, "vitrina canary", "Error");
  await visitAndReload(page, QR());
  await expect.poll(violations).toContain("page error: vitrina canary");
});

test("WebKit's abort report is not tolerated for a URL the test did not abort, in either browser", async ({ page }) => {
  const aborted = new Set<string>();
  const violations = await watch(page, { aborted });
  await cutTheApi(page, aborted);
  const message = `Fetch API cannot load ${apiOrigin()}/never-requested due to access control checks.`;
  await throwOnRoot(page, message, "TypeError");
  await visitAndReload(page, QR());
  await expect.poll(violations).toContain(`page error: ${message}`);
});

test("WebKit's abort report for a URL the test aborted is tolerated in WebKit only", async ({ page, browserName }) => {
  const aborted = new Set<string>();
  const violations = await watch(page, { aborted });
  await cutTheApi(page, aborted);
  // The QR page's first request, which cutTheApi aborts before the round trip.
  const url = `${apiOrigin()}/v1/recipient/key`;
  const message = `Fetch API cannot load ${url} due to access control checks.`;
  await throwOnRoot(page, message, "TypeError");
  await visitAndReload(page, QR());
  expect(aborted.has(url), "the QR page's request was aborted").toBe(true);
  if (browserName === "webkit") {
    await page.waitForTimeout(250); // let the report arrive, so its absence means something
    expect(await violations()).toEqual([]);
  } else {
    await expect.poll(violations).toContain(`page error: ${message}`);
  }
});
