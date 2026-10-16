import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import {
  announcerStyle,
  blocklistFilter,
  noVersionCheck,
  envelopeWasm,
  guards,
  parseApiOrigin,
} from "./vite-plugins.ts";

/*
 * Headers a <meta> tag cannot carry. Whoever chooses hosting sets these on
 * every response that serves build/; nothing here can.
 *
 *   Content-Security-Policy: frame-ancestors 'none'
 *       — ignored in a meta CSP. Without it the app can be framed.
 *   Referrer-Policy: no-referrer
 *       — app.html sets the meta equivalent and the API client sets it per
 *         request; the header also covers the document and its subresources
 *         before the meta tag is parsed.
 *   Serve build/index.html for every path that is not a file, /v/ included.
 */

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ command, mode }) => {
  const apiOrigin = parseApiOrigin(
    process.env["VITE_API_ORIGIN"] ??
      loadEnv(mode, root, "VITE_")["VITE_API_ORIGIN"],
  );

  return {
    plugins: [
      guards(root),
      announcerStyle(),
      noVersionCheck(),
      envelopeWasm(root),
      blocklistFilter(root),
      sveltekit({
        // Source, not dist/: the client only takes types from it, and `pnpm lint`
        // runs before anything has built shared/ (CI's order). A dist/ that
        // happens to exist is whatever the last build left.
        alias: { "@vitrina/shared": "../shared/src/index.ts" },
        // Static output, one HTML shell; the host routes every path to it.
        adapter: adapter({ fallback: "index.html", strict: true }),
        // Turned off, and guards.ts refuses a src/service-worker file besides.
        serviceWorker: { register: false },
        // No background polling of version.json.
        version: { pollInterval: 0 },
        csp: {
          mode: "hash",
          directives: {
            "default-src": ["self"],
            "script-src": ["self", "wasm-unsafe-eval"],
            // The API and nothing else. The WASM is inlined into the bundle
            // (src/lib/envelope.ts) so loading it is not a fetch from 'self'.
            // `vite dev` alone adds 'self' for its HMR socket; check-build.mjs
            // fails a production build whose connect-src names anything else.
            "connect-src": [
              apiOrigin as
                | `${string}.${string}`
                | `${string}://localhost:${number}`,
              ...(command === "serve" ? (["self"] as const) : []),
            ],
            "img-src": ["self", "blob:"],
            // Stylesheets from our own origin only, stated rather than inherited from
            // default-src. No inline styles: see announcerStyle() in vite-plugins.ts.
            "style-src": ["self"],
            // Atkinson Hyperlegible, from static/fonts/ (theme.css). Same origin only.
            "font-src": ["self"],
            // Neither falls back to default-src.
            "base-uri": ["none"],
            "form-action": ["none"],
          },
        },
      }),
    ],
    // One validated value feeds both connect-src above and the API client.
    define: { __VITRINA_API_ORIGIN__: JSON.stringify(apiOrigin) },
    // packages/server's CLIENT_ORIGIN is http://localhost:5173 (.env.example).
    // strictPort, so a busy port fails instead of moving to one CORS refuses.
    // No proxy: the API stays cross-origin in development, as in production.
    server: { port: 5173, strictPort: true },
    test: {
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      environment: "node",
    },
  };
});
