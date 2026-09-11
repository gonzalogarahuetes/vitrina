// Static server for the device trip. Binds 0.0.0.0 so a phone on the same
// network can reach it, and serves fixtures with no-store so measurement D
// tests the real re-download cost rather than the browser's cache.
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { extname } from "node:path";

const ROOT = new URL("../", import.meta.url);
const PORT = Number(process.env.PORT ?? 8080);
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".bin": "application/octet-stream",
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // The phone posts its log here, so the result lands on the laptop instead
  // of being transcribed from a screenshot.
  if (req.method === "POST" && path === "/results") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const name = `results-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    await mkdir(new URL("./device/results/", ROOT), { recursive: true });
    await writeFile(new URL(`./device/results/${name}`, ROOT), Buffer.concat(chunks));
    console.log(`wrote device/results/${name}`);
    res.writeHead(200, { "content-type": "text/plain" }).end(name);
    return;
  }
  if (path.includes("..")) {
    res.writeHead(400).end("no");
    return;
  }
  // Redirect rather than serve index.html at "/": a module specifier resolves
  // against the page URL, so "./run.js" at "/" would look for /run.js.
  if (path === "/") {
    res.writeHead(302, { location: "/device/index.html" }).end();
    return;
  }
  const target = new URL("." + (path.endsWith("/") ? path + "index.html" : path), ROOT);
  try {
    const body = await readFile(target);
    const headers = { "content-type": TYPES[extname(target.pathname)] ?? "application/octet-stream" };
    if (path.startsWith("/device/fixtures/")) headers["cache-control"] = "no-store";
    res.writeHead(200, headers).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(PORT, "0.0.0.0", () => {
  const addrs = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i.address);
  console.log(`serving ${ROOT.pathname}`);
  for (const a of addrs) console.log(`  http://${a}:${PORT}/`);
});
