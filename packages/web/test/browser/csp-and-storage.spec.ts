/*
 * The production build in a real browser (Chromium, and WebKit as the closest
 * CI gets to iPhone Safari, still an approximation). Four pages, none needing
 * the API: the three static screens, and a QR invite whose key is held in
 * memory while every API request fails, so the app sits in its offline state.
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
 *      (numbers only) and an empty sveltekit:snapshot. Nothing else, and none
 *      of the invite's secrets anywhere.
 *
 * The last tests break each check on purpose and expect it to notice, so every
 * run proves the detectors still work. The CSP ones run in Chromium only, for
 * the reason above.
 *
 * Covers the recipient routes only. When the owner routes land, they need
 * their own pages here and their own allowlist: the owner token and its
 * expiry are meant to be in sessionStorage (flows §1.1), which this allowlist
 * refuses. The full grid-and-viewer path, with a faked API, is a later step.
 */
import { expect, test, type Page } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { storageViolations, type StorageDump } from "../storage-allowlist.ts";

const text = (copy: string) => async (page: Page) => {
  await expect(page.getByText(copy, { exact: true })).toBeVisible();
};

/** A QR invite with fixed values: canonical base64url, as the owner's client writes it. */
const b64url = (bytes: Buffer) => bytes.toString("base64url");
const ALBUM = Buffer.alloc(16, 0x11);
const TOKEN = Buffer.alloc(32, 0x22);
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
const QR_FRAGMENT = `v=1&a=${b64url(ALBUM)}&t=${b64url(TOKEN)}&k=${b64url(KEY)}`;

/** Every spelling of the invite's secrets that could end up stored. */
const SECRETS = [QR_FRAGMENT, b64url(KEY), KEY.toString("base64"), KEY.toString("hex"), b64url(TOKEN)];

type Visit = {
  readonly name: string;
  readonly path: string;
  readonly ready: (page: Page) => Promise<void>;
  readonly secrets: readonly string[];
  /** After the reload, also navigate to `/` and back: SvelteKit persists again on leaving. */
  readonly roundTrip?: boolean;
};

const PAGES: readonly Visit[] = [
  { name: "root", path: "/", ready: async (page) => expect(page.locator("[data-state='envelope-ready']")).toBeVisible(), secrets: [] },
  { name: "dead page", path: "/v/", ready: text(en.dead), secrets: [] },
  { name: "newer version", path: "/v/#v=2&x=y", ready: text(en["open.newer-version"]), secrets: ["v=2&x=y"] },
  // The key is opened and held in memory; the first request fails, so the app waits offline.
  {
    name: "QR invite, key in memory, API unreachable",
    path: `/v/#${QR_FRAGMENT}`,
    ready: text(en.offline),
    secrets: SECRETS,
    roundTrip: true,
  },
];

/** Every request to anything but the page's own origin fails, as with no network. */
async function cutTheApi(page: Page): Promise<void> {
  const base = test.info().project.use.baseURL;
  if (base === undefined) throw new Error("playwright.config.ts sets no baseURL");
  const own = new URL(base).origin;
  await page.route((url) => url.origin !== own, (route) => route.abort("internetdisconnected"));
}

declare global {
  interface Window {
    __reportCsp?: (violation: string) => void;
  }
}

/**
 * Starts recording on `page`, across every document it loads (reloads
 * included): CSP events, CSP console messages, uncaught page errors. The
 * returned function reads everything recorded so far.
 */
async function watch(page: Page): Promise<() => Promise<string[]>> {
  const seen: string[] = [];
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) seen.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => seen.push(`page error: ${e.message.slice(0, 200)}`));
  // A binding outlives navigations; the listener is installed before any page script.
  await page.exposeFunction("__reportCsp", (v: string) => void seen.push(v));
  await page.addInitScript(() => {
    document.addEventListener(
      "securitypolicyviolation",
      (e) => window.__reportCsp?.(`${e.effectiveDirective} blocked ${e.blockedURI || "inline"}`),
      true,
    );
  });
  return async () => [...seen];
}

/** Everything persistent the page can see, read inside the page. */
async function dumpStorage(page: Page): Promise<StorageDump> {
  return page.evaluate(async () => {
    const entries = (s: Storage): Record<string, string> => {
      const out: Record<string, string> = {};
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (k !== null) out[k] = s.getItem(k) ?? "";
      }
      return out;
    };
    const idb = typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map((d) => d.name ?? "") : [];
    const cacheNames = typeof caches === "undefined" ? [] : await caches.keys();
    const opfs: string[] = [];
    try {
      const root = (await navigator.storage.getDirectory()) as unknown as { keys(): AsyncIterable<string> };
      for await (const name of root.keys()) opfs.push(name);
    } catch {
      // No origin private file system in this browser: nothing stored there.
    }
    return {
      sessionStorage: entries(sessionStorage),
      localStorage: entries(localStorage),
      indexedDB: idb,
      cacheStorage: cacheNames,
      opfs,
      cookies: document.cookie,
      windowName: window.name,
      historyState: history.state as unknown,
    };
  });
}

/**
 * Load, reload once (and, for the key page, go to `/` and back), then read
 * storage. Each unload is a point where SvelteKit writes sessionStorage.
 */
async function visitAndReload(page: Page, visit: Visit): Promise<StorageDump> {
  await page.goto(visit.path);
  await visit.ready(page);
  await page.reload();
  await page.waitForLoadState("load");
  if (visit.roundTrip === true) {
    await page.goto("/");
    await page.goBack();
    await page.waitForLoadState("load");
    await text(en.dead)(page); // the fragment was stripped, so /v/ comes back as the dead page
  }
  return dumpStorage(page);
}

for (const visit of PAGES) {
  test(`${visit.name}: no CSP violation, and storage holds only what is permitted after a reload`, async ({ page, context }) => {
    const violations = await watch(page);
    await cutTheApi(page);
    const dump = await visitAndReload(page, visit);
    const cookies = await context.cookies();

    expect(await violations(), "CSP violations").toEqual([]);
    expect(storageViolations(dump, visit.secrets), "storage").toEqual([]);
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
  }, b64url(KEY));
  const dump = await visitAndReload(page, qr);
  const found = storageViolations(dump, qr.secrets);
  // Exactly one finding, naming window.name. Which secret numbers it lists
  // depends on which spellings of k coincide, so they are computed, not fixed.
  const k = b64url(KEY);
  const hits = qr.secrets.flatMap((secret, i) => (k.includes(secret) ? [`#${i}`] : []));
  expect(found).toEqual([`window.name holds secret ${hits.join(", ")}`]);
  expect(found.join(" ")).not.toContain(k);
});
