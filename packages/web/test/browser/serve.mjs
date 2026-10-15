/*
 * Serves build/ for the browser check, as any static host would: files as they
 * are, and index.html for every path that is not a file (adapter-static's
 * fallback; vite.config.ts's header comment). Nothing else. The CSP is a
 * <meta> tag in index.html, so the browser enforces it with no help from here.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const BUILD = fileURLToPath(new URL("../../build/", import.meta.url));
const PORT = Number(process.env["PORT"] ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

if (!existsSync(join(BUILD, "index.html"))) {
  console.error("build/ is missing: run `pnpm --filter @vitrina/web build` first");
  process.exit(1);
}

createServer((req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = normalize(join(BUILD, path));
  const inside = file.startsWith(BUILD); // BUILD ends in a separator, so ../ cannot escape it
  const target = inside && existsSync(file) && statSync(file).isFile() ? file : join(BUILD, "index.html");
  res.writeHead(200, { "Content-Type": TYPES[extname(target)] ?? "application/octet-stream" });
  createReadStream(target).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`serving build/ on http://127.0.0.1:${PORT}`));
