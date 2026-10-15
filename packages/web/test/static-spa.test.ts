import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { disableVersionCheck, forbiddenSourcePaths, parseApiOrigin, stripAnnouncerStyle } from "../vite-plugins";
import * as rootLayout from "../src/routes/+layout";
import * as recipientPage from "../src/routes/v/+page";

describe("a static single-page app", () => {
  it("renders nothing on a server and prerenders nothing", () => {
    expect(rootLayout.ssr).toBe(false);
    expect(rootLayout.prerender).toBe(false);
  });

  it("reserves /v/ with its trailing slash (invite spec §2)", () => {
    expect(recipientPage.trailingSlash).toBe("always");
  });

  it("refuses every kind of SvelteKit server file and a service worker", () => {
    const forbidden = [
      "src/routes/+server.ts",
      "src/routes/api/+server.js",
      "src/routes/+page.server.ts",
      "src/routes/+layout.server.ts",
      "src/hooks.server.ts",
      "src/lib/server",
      "src/lib/server/db.ts",
      "src/lib/secrets.server.ts",
      "src/lib/server.ts",
      "src/lib/data.remote.ts",
      "src/service-worker.ts",
      "src/service-worker/index.ts",
    ];
    expect(forbiddenSourcePaths(forbidden)).toEqual(forbidden);
  });

  it("allows what a client-only app has", () => {
    const allowed = [
      "src/routes/+page.svelte",
      "src/routes/+layout.ts",
      "src/routes/v/+page.ts",
      "src/hooks.client.ts",
      "src/lib/api/client.ts",
      "src/lib/observer.ts",
    ];
    expect(forbiddenSourcePaths(allowed)).toEqual([]);
  });
});

describe("VITE_API_ORIGIN", () => {
  it("is required", () => {
    expect(() => parseApiOrigin(undefined)).toThrow();
    expect(() => parseApiOrigin("")).toThrow();
  });
  it("is https unless localhost, and a bare origin", () => {
    expect(parseApiOrigin("https://api.vitrina.test/")).toBe("https://api.vitrina.test");
    expect(parseApiOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(() => parseApiOrigin("http://api.vitrina.test")).toThrow();
    expect(() => parseApiOrigin("https://api.vitrina.test/v1")).toThrow();
    expect(() => parseApiOrigin("https://api.vitrina.test/#k=x")).toThrow();
  });
});

/*
 * SvelteKit's route announcer carries an inline style attribute, which
 * style-src 'self' blocks. Read from the SvelteKit actually installed, so an
 * upgrade that changes the markup fails here as well as in the build.
 */
describe("the route announcer under style-src 'self'", () => {
  const writeRoot = readFileSync(new URL("../node_modules/@sveltejs/kit/src/core/sync/write_root.js", import.meta.url), "utf8");
  const announcer = /<div id="svelte-announcer"[^>]*>/.exec(writeRoot)?.[0] ?? "";
  const inline = /style="([^"]*)"/.exec(announcer)?.[1] ?? "";

  it("loses its style attribute, and nothing else", () => {
    expect(inline).not.toBe("");
    const stripped = stripAnnouncerStyle(writeRoot);
    const after = /<div id="svelte-announcer"[^>]*>/.exec(stripped)?.[0] ?? "";
    expect(after).toBe('<div id="svelte-announcer" aria-live="assertive" aria-atomic="true">');
    expect(stripped.length).toBe(writeRoot.length - (announcer.length - after.length));
  });

  it("fails loudly when the markup it expects is gone", () => {
    expect(() => stripAnnouncerStyle('<div id="svelte-announcer">')).toThrow(/no longer has the announcer/);
  });

  it("gets every rule it lost from theme.css instead", () => {
    const theme = readFileSync(new URL("../src/lib/theme.css", import.meta.url), "utf8");
    const rule = /#svelte-announcer\s*\{([^}]*)\}/.exec(theme)?.[1] ?? "";
    const declarations = (css: string) =>
      new Set(css.split(";").map((d) => d.trim().replace(/\s*:\s*/, ": ")).filter((d) => d !== ""));
    expect(declarations(rule)).toEqual(declarations(inline));
  });
});

/*
 * SvelteKit's version check fetches _app/version.json, which connect-src
 * refuses. Read from the SvelteKit actually installed, so an upgrade that
 * changes the function fails here as well as in the build.
 */
describe("SvelteKit's version check", () => {
  const utils = readFileSync(new URL("../node_modules/@sveltejs/kit/src/runtime/client/utils.js", import.meta.url), "utf8");

  it("returns false before it can fetch", () => {
    const patched = disableVersionCheck(utils);
    const check = /async function check\(\) \{([\s\S]*?)\n\t\}/.exec(patched)?.[1] ?? "";
    const returnAt = check.indexOf("return false;");
    expect(returnAt).toBeGreaterThan(-1);
    expect(returnAt).toBeLessThan(check.indexOf("fetch("));
  });

  it("fails loudly when the function it expects is gone", () => {
    expect(() => disableVersionCheck("export function create_updated_store() {}")).toThrow(/no longer looks/);
  });
});
