/*
 * The JPEG quality page's own build, apart from the app's (vite.config.ts in
 * packages/web is never loaded for it: Vite looks for a config in the root it
 * is given, which is this folder). Built, then served by `vite preview`, so no
 * dev server's HMR socket runs beside a page whose CSP refuses every request.
 */
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The polyfill preloads modules with fetch(), which connect-src 'none' refuses anyway.
    modulePreload: { polyfill: false },
  },
  // Plain HTTP on every interface, for phones on the same Wi-Fi: no crypto here,
  // so no secure context is needed. Stop it when done.
  preview: { host: true, port: 5181, strictPort: true },
});
