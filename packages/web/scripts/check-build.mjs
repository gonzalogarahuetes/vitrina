/*
 * Runs after `vite build`, on build/ — what would actually be served. Each
 * check is a guard from the scaffold's settled list that the browser would
 * otherwise enforce only at runtime, where CI never looks.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const BUILD = new URL("../build/", import.meta.url).pathname;
const failures = [];
const fail = (msg) => failures.push(msg);

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const html = readFileSync(join(BUILD, "index.html"), "utf8");

// --- CSP --------------------------------------------------------------------
const metas = [...html.matchAll(/<meta http-equiv="content-security-policy" content="([^"]*)"/gi)];
if (metas.length !== 1) fail(`expected one CSP meta tag, found ${metas.length}`);
const directives = new Map(
  (metas[0]?.[1] ?? "")
    .split(";")
    .map((d) => d.trim().split(/\s+/))
    .filter((d) => d[0])
    .map(([name, ...values]) => [name, values]),
);
const csp = (name) => directives.get(name) ?? [];
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

if (!same(csp("default-src"), ["'self'"])) fail(`default-src is ${csp("default-src").join(" ")}`);
if (!same(csp("img-src"), ["'self'", "blob:"])) fail(`img-src is ${csp("img-src").join(" ")}`);
if (!same(csp("style-src"), ["'self'"])) fail(`style-src is ${csp("style-src").join(" ") || "absent"}`);
if (!same(csp("font-src"), ["'self'"])) fail(`font-src is ${csp("font-src").join(" ") || "absent"}`);

// The only inline script allowed is SvelteKit's bootstrap, admitted by hash.
const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
const inlineHashes = inline.map((s) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`);
const [s0, s1, ...hashes] = csp("script-src");
if (s0 !== "'self'" || s1 !== "'wasm-unsafe-eval'") fail(`script-src is ${csp("script-src").join(" ")}`);
if (inline.length > 1) fail(`${inline.length} inline scripts; only SvelteKit's bootstrap is allowed`);
for (const h of hashes) {
  if (!/^'sha256-[A-Za-z0-9+/=]+'$/.test(h)) fail(`script-src carries ${h}`);
  else if (!inlineHashes.includes(h)) fail(`script-src hash ${h} matches no inline script`);
}
for (const [name, values] of directives) {
  for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "*", "data:", "https:", "http:"]) {
    if (values.includes(bad)) fail(`${name} carries ${bad}`);
  }
}

const connect = csp("connect-src");
let apiOrigin;
if (connect.length !== 1) fail(`connect-src must name the API origin alone: ${connect.join(" ")}`);
else {
  apiOrigin = new URL(connect[0]).origin;
  if (apiOrigin !== connect[0]) fail(`connect-src is not a bare origin: ${connect[0]}`);
}

// Inline handlers and style attributes would need 'unsafe-inline' to run.
if (/\son[a-z]+\s*=/i.test(html)) fail("index.html has an inline event handler");
if (/\sstyle\s*=/i.test(html)) fail("index.html has a style attribute");

// --- Same-origin CSS references resolve -------------------------------------
// Every url() in the built CSS must be a file in build/: a font named in
// theme.css but missing from static/fonts/ would otherwise fall back silently.
// A data: URI is refused too — CSP admits none, so it would fail at runtime.
for (const f of files(BUILD).filter((f) => f.endsWith(".css"))) {
  const text = readFileSync(f, "utf8");
  for (const [, ref] of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    if (/^(?:https?:)?\/\//i.test(ref)) continue; // reported below as a third-party origin
    if (/^data:/i.test(ref)) {
      fail(`${relative(BUILD, f)} inlines a data: URI, which CSP refuses`);
      continue;
    }
    const target = ref.startsWith("/") ? join(BUILD, ref.split(/[?#]/)[0]) : join(dirname(f), ref.split(/[?#]/)[0]);
    if (!existsSync(target)) fail(`${relative(BUILD, f)} references ${ref}, which is not in build/`);
  }
}

// --- No inline style attributes in built templates ---------------------------
// Svelte compiles markup to HTML template strings. A `style="…"` inside one is
// parsed as an inline style, which style-src 'self' blocks at runtime; this is
// how SvelteKit's announcer slipped through (vite-plugins.ts). A static scan
// only: it cannot see styles set as text at runtime (setAttribute, cssText, an
// injected <style>). The browser check is what covers those.
for (const f of files(BUILD).filter((f) => f.endsWith(".js"))) {
  const text = readFileSync(f, "utf8");
  for (const [tag] of text.matchAll(/<[a-zA-Z][\w-]*\s[^<>]*\bstyle\s*=\s*["'][^<>]*>/g)) {
    fail(`${relative(BUILD, f)} has an inline style attribute in markup: ${tag.slice(0, 80)}`);
  }
}

// --- No version check -------------------------------------------------------
// SvelteKit fetches _app/version.json after a failed route load, from the
// app's own origin, which connect-src refuses (vite-plugins.ts,
// noVersionCheck). The client bundle must not even name it.
for (const f of files(BUILD).filter((f) => f.endsWith(".js"))) {
  if (readFileSync(f, "utf8").includes("version.json")) fail(`${relative(BUILD, f)} still fetches version.json`);
}

// --- No service worker ------------------------------------------------------
for (const f of files(BUILD)) {
  if (/service-worker|(^|\/)sw\.js$/.test(relative(BUILD, f))) fail(`service worker in build: ${relative(BUILD, f)}`);
}

// --- No third-party origins -------------------------------------------------
// HTML and CSS reference nothing absolute: fonts, styles and scripts are ours.
for (const f of files(BUILD).filter((f) => /\.(html|css)$/.test(f))) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/(?:src|href)\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)|url\(\s*["']?((?:https?:)?\/\/[^"')]+)|@import\s+["']((?:https?:)?\/\/[^"']+)/gi)) {
    fail(`${relative(BUILD, f)} references ${m[1] ?? m[2] ?? m[3]}`);
  }
}

// JS may mention an absolute URL only if it is the API, an XML namespace, or
// one of Svelte's error-documentation links (text in a message, never fetched).
// An analytics or error-reporting SDK ships its endpoint; this is where it shows.
const ALLOWED = [
  (u) => apiOrigin !== undefined && u.origin === apiOrigin,
  (u) => u.origin === "http://www.w3.org",
  (u) => u.origin === "https://svelte.dev" && u.pathname.startsWith("/e/"),
];
for (const f of files(BUILD).filter((f) => f.endsWith(".js"))) {
  const text = readFileSync(f, "utf8");
  for (const [raw] of text.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?::\d+)?[A-Za-z0-9/_.-]*/g)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      fail(`${relative(BUILD, f)}: unparseable URL ${raw}`);
      continue;
    }
    if (!ALLOWED.some((ok) => ok(url))) fail(`${relative(BUILD, f)} mentions ${raw}`);
  }
}

if (failures.length > 0) {
  console.error("check-build: build/ violates the static-SPA guards\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log(`check-build: ok (connect-src ${apiOrigin}, ${inline.length} inline script by hash)`);
