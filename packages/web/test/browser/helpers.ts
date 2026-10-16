/*
 * Shared by the browser specs: the CSP and error watcher, the storage dump,
 * the API cut, and the facts read from build/ (the API origin and the
 * blocklist chunk). Moved here unchanged from csp-and-storage.spec.ts when the
 * owner routes got a spec of their own.
 */
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { StorageDump } from "../storage-allowlist.ts";
import { isToleratedAbortReport } from "./abort-report.ts";

const BUILD = fileURLToPath(new URL("../../build/", import.meta.url));

export const text = (copy: string) => async (page: Page) => {
  await expect(page.getByText(copy, { exact: true })).toBeVisible();
};

/** The API origin the build was made for: CSP connect-src's one entry. */
export function apiOrigin(): string {
  const html = readFileSync(join(BUILD, "index.html"), "utf8");
  const csp = /<meta http-equiv="content-security-policy" content="([^"]*)"/i.exec(html)?.[1] ?? "";
  const connect = csp
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .find((d) => d[0] === "connect-src");
  const origin = connect?.[1];
  if (origin === undefined) throw new Error("build/index.html has no connect-src");
  return origin;
}

/** The blocklist chunk's file name, found as check-build.mjs finds it. */
export function blocklistChunk(): string {
  const dir = join(BUILD, "_app/immutable/chunks");
  const found = readdirSync(dir).filter((f) => f.endsWith(".js") && readFileSync(join(dir, f), "utf8").includes("vitrina:password-blocklist"));
  if (found.length !== 1) throw new Error(`expected one blocklist chunk in build/, found ${found.length}`);
  return found[0] as string;
}

/**
 * Every request to anything but the page's own origin fails, as with no
 * network. Each aborted URL is added to `aborted` BEFORE the abort, so a
 * report of it can never arrive first. Pass the same set to watch().
 */
export async function cutTheApi(page: Page | BrowserContext, aborted?: Set<string>): Promise<void> {
  const base = test.info().project.use.baseURL;
  if (base === undefined) throw new Error("playwright.config.ts sets no baseURL");
  const own = new URL(base).origin;
  await page.route(
    (url) => url.origin !== own,
    (route) => {
      aborted?.add(route.request().url());
      return route.abort("internetdisconnected");
    },
  );
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
 *
 * `aborted`: the URLs this test's cutTheApi aborted. With it, and only in
 * WebKit, the one report abort-report.ts describes is tolerated for exactly
 * those URLs. Every other page error still counts.
 */
export async function watch(page: Page, opts: { aborted?: ReadonlySet<string> } = {}): Promise<() => Promise<string[]>> {
  const seen: string[] = [];
  const browserName = page.context().browser()?.browserType().name() ?? "";
  page.on("console", (m) => {
    if (/content security policy/i.test(m.text())) seen.push(`console: ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) => {
    if (opts.aborted !== undefined && isToleratedAbortReport(e.message, opts.aborted, browserName)) return;
    seen.push(`page error: ${e.message.slice(0, 200)}`);
  });
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
export async function dumpStorage(page: Page): Promise<StorageDump> {
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
