/*
 * Build-time guards and the WASM module, wired in vite.config.ts, so
 * `vite dev`, `vite build` and `vitest` all refuse to start when a guard fails.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin } from "vite";

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

export function guards(root: string): Plugin {
  return {
    name: "vitrina:guards",
    enforce: "pre",
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
