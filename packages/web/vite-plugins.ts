/*
 * Build-time guards and the WASM module, wired in vite.config.ts, so
 * `vite dev`, `vite build` and `vitest` all refuse to start when a guard fails.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";
import { MAX_CODE_POINTS, MIN_CODE_POINTS } from "./src/lib/owner/policy.ts";

/*
 * A static single-page app: no SvelteKit server code of any kind. Access
 * control lives in packages/server (brief §6 #5); SvelteKit's server features
 * are the easiest way to grow a second, unaudited backend.
 *
 * Matched per path segment, on the dot-separated parts of each name, so it
 * covers +server, +page.server, +layout.server, hooks.server, *.server.*,
 * any `server/` directory, and SvelteKit 3's spellings (`server.ts`, remote
 * functions as `*.remote.*`) before the upgrade makes them live. Form actions
 * can only be declared in +page.server, so they are covered too.
 *
 * A service worker is forbidden for a different reason: one caching responses
 * would quietly defeat `Cache-Control: no-store` on ciphertext (brief §10).
 */
const FORBIDDEN_PARTS = new Set(["server", "+server", "remote", "service-worker"]);

export function forbiddenSourcePaths(paths: readonly string[]): string[] {
  return paths.filter((path) =>
    path
      .split(/[\\/]/)
      .some((segment) => segment.split(".").some((part) => FORBIDDEN_PARTS.has(part))),
  );
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    // A directory is reported itself (an empty `server/` is still a mistake)
    // and then walked.
    return entry.isDirectory() ? [full, ...walk(full)] : [full];
  });
}

/*
 * The WASM build is gitignored (CI builds it before any JS step). Without it
 * the import below fails with an unresolved-module error several layers from
 * the cause; this names the cause.
 */
export const ENVELOPE_WASM = "../envelope/wasm/envelope_bg.wasm";

/*
 * The top-100k password blocklist (brief §12), supplied by the owner like the
 * font and committed. Never downloaded. Signup imports it dynamically
 * (lib/owner/blocklist.ts). The unit tests inject their own list, so `vitest`
 * does not need the file. `vite dev` and `vite build` do.
 */
export const BLOCKLIST_FILE = "src/lib/owner/passwords-top-100k.txt";

export function guards(root: string): Plugin {
  let mode = "";
  return {
    name: "vitrina:guards",
    enforce: "pre",
    configResolved(config) {
      mode = config.mode;
    },
    buildStart() {
      const src = join(root, "src");
      const found = forbiddenSourcePaths(walk(src).map((p) => relative(root, p).split(sep).join("/")));
      if (found.length > 0) {
        throw new Error(
          "packages/web is a static SPA: no SvelteKit server code, no service worker " +
            "(brief §6 #5, §10). Remove:\n  " +
            found.join("\n  "),
        );
      }
      if (!existsSync(join(root, ENVELOPE_WASM))) {
        throw new Error(
          "packages/envelope/wasm/ is missing. Build it first: pnpm --filter @vitrina/envelope build:wasm",
        );
      }
      if (mode !== "test" && !existsSync(join(root, BLOCKLIST_FILE))) {
        throw new Error(
          `${BLOCKLIST_FILE} is missing. The owner supplies it (brief §12): one password per line, UTF-8. ` +
            "It is not downloaded, here or anywhere.",
        );
      }
    },
  };
}

/*
 * SvelteKit's generated root component renders its route announcer with an
 * inline `style` attribute (core/sync/write_root.js). Svelte builds it from an
 * HTML template, so under `style-src 'self'` the attribute is blocked and the
 * browser reports a CSP violation on every page load. The same rules live in
 * theme.css as `#svelte-announcer`; this removes only the attribute, before
 * Svelte compiles the file.
 *
 * Loud on purpose: if SvelteKit changes that markup, or the build never sees
 * root.svelte, the build fails instead of the violation quietly coming back.
 */
const ROOT_SVELTE = /[\\/]\.svelte-kit[\\/]generated[\\/]root\.svelte$/;
const ANNOUNCER_STYLE = /(<div id="svelte-announcer"[^>]*?)\s+style="[^"]*"/;

export function stripAnnouncerStyle(source: string): string {
  if (!ANNOUNCER_STYLE.test(source)) {
    throw new Error(
      "SvelteKit's root.svelte no longer has the announcer's inline style this plugin removes. " +
        "Check the new markup against style-src 'self' and update vite-plugins.ts and theme.css.",
    );
  }
  return source.replace(ANNOUNCER_STYLE, "$1");
}

export function announcerStyle(): Plugin {
  let seen = false;
  return {
    name: "vitrina:announcer-style",
    enforce: "pre",
    buildStart() {
      seen = false;
    },
    transform(code, id) {
      if (!ROOT_SVELTE.test(id.split("?")[0] ?? id)) return undefined;
      seen = true;
      return { code: stripAnnouncerStyle(code), map: null };
    },
    generateBundle() {
      if (!seen) throw new Error("vitrina:announcer-style never saw .svelte-kit/generated/root.svelte");
    },
  };
}

/*
 * SvelteKit's version check. After a failed route load or on reaching an
 * error page (@sveltejs/kit src/runtime/client/client.js, the two calls to
 * `stores.updated.check()`), a production build fetches `_app/version.json`
 * from the app's own origin (src/runtime/client/utils.js, create_updated_store)
 * to see whether a redeploy explains the failure. connect-src names the API
 * alone, deliberately: a same-origin request still reaches the static host and
 * its logs. So every such fetch was already refused by the CSP, and check()
 * already always returned false; this makes it return false without asking.
 * `version.pollInterval: 0` stops only the timer, and no option stops the rest.
 *
 * Loud on purpose, like announcerStyle(): if SvelteKit changes the function,
 * or the build never sees the file, the build fails.
 */
const KIT_CLIENT_UTILS = /[\\/]@sveltejs[\\/]kit[\\/]src[\\/]runtime[\\/]client[\\/]utils\.js$/;
const VERSION_CHECK = /(async function check\(\) \{\s*clearTimeout\(timeout\);)/;

export function disableVersionCheck(source: string): string {
  if (!VERSION_CHECK.test(source) || !source.includes("fetch(`${assets}/${__SVELTEKIT_APP_VERSION_FILE__}`")) {
    throw new Error(
      "SvelteKit's create_updated_store() no longer looks as vite-plugins.ts expects. " +
        "Check whether it still fetches version.json, and update disableVersionCheck().",
    );
  }
  return source.replace(VERSION_CHECK, "$1\n\t\treturn false; // vitrina: no version.json request (vite-plugins.ts)");
}

export function noVersionCheck(): Plugin {
  let seen = false;
  return {
    name: "vitrina:no-version-check",
    enforce: "pre",
    apply: "build",
    buildStart() {
      seen = false;
    },
    transform(code, id) {
      if (!KIT_CLIENT_UTILS.test(id.split("?")[0] ?? id)) return undefined;
      seen = true;
      return { code: disableVersionCheck(code), map: null };
    },
    generateBundle(options) {
      // The server build of adapter-static never imports the client runtime.
      if (!seen && options.format === "es" && this.environment?.name !== "ssr") {
        throw new Error("vitrina:no-version-check never saw @sveltejs/kit's client utils.js");
      }
    },
  };
}

/*
 * `virtual:envelope-wasm` — the module's bytes as base64, so they ship inside
 * the JS bundle and loading them is not a fetch (CSP connect-src names the API
 * alone). Vite has no `?inline` for .wasm; this is that, and nothing more.
 */
const WASM_ID = "virtual:envelope-wasm";

export function envelopeWasm(root: string): Plugin {
  return {
    name: "vitrina:envelope-wasm",
    resolveId(id) {
      return id === WASM_ID ? "\0" + WASM_ID : undefined;
    },
    load(id) {
      if (id !== "\0" + WASM_ID) return undefined;
      const path = join(root, ENVELOPE_WASM);
      this.addWatchFile(path);
      return `export default ${JSON.stringify(readFileSync(path).toString("base64"))};`;
    },
  };
}

/*
 * The API origin, validated the way packages/server validates CLIENT_ORIGIN:
 * https unless localhost, and a bare origin. It becomes CSP `connect-src` and
 * the API client's base, so a malformed value fails here rather than as an
 * opaque CORS or CSP error in a console. Absent is a hard failure (brief §6 #17).
 */
export function parseApiOrigin(raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new Error("VITE_API_ORIGIN is not set (packages/web/.env sets it for local development)");
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error(`VITE_API_ORIGIN must be https unless localhost: ${raw}`);
  }
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`VITE_API_ORIGIN must be an origin, not a URL: ${raw}`);
  }
  return url.origin;
}

/*
 * The blocklist as bundled: only the entries the policy can ever match. An
 * entry shorter than 12 or longer than 256 code points is refused by the
 * length check before the blocklist is consulted (lib/owner/policy.ts), so
 * dropping it changes no outcome. Of a top-100k list, about one entry in a
 * hundred survives, which is most of the chunk's weight gone. It also keeps
 * entries like `http://www` out of the bundle, where check-build.mjs's URL
 * scan would rightly refuse them. The file on disk stays as supplied.
 */
export function filterBlocklist(raw: string): string {
  return raw
    .split("\n")
    .map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line))
    .filter((line) => {
      const n = [...line].length;
      return n >= MIN_CODE_POINTS && n <= MAX_CODE_POINTS;
    })
    .join("\n");
}

export function blocklistFilter(root: string): Plugin {
  const file = join(root, BLOCKLIST_FILE);
  return {
    name: "vitrina:blocklist-filter",
    enforce: "pre",
    load(id) {
      const [path, query] = id.split("?");
      if (path !== file || query !== "raw") return undefined;
      this.addWatchFile(file);
      return `export default ${JSON.stringify(filterBlocklist(readFileSync(file, "utf8")))};`;
    },
  };
}
