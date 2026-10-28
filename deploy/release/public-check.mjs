/*
 * What anyone on the internet sees, checked after every release (deploy.sh)
 * and by verify.sh. No credentials: every request is anonymous. Exit 1 if
 * anything is missing or extra.
 *
 *   node deploy/release/public-check.mjs
 */

import { request as httpRequest } from "node:http";

const APP = "https://app.lirioapp.eu";
const API = "https://api.lirioapp.eu";
const HSTS = "max-age=31536000";
let fails = 0;
const pass = (m) => console.log(`PASS ${m}`);
const bad = (m) => (fails++, console.log(`FAIL ${m}`));
const expect = (ok, m, got) => (ok ? pass(m) : bad(got === undefined ? m : `${m} — got ${got}`));
const get = (url, init = {}) => fetch(url, { redirect: "manual", ...init });

/** Plain HTTP: fetch cannot be told not to upgrade, so ask node:http directly. */
const plain = (url) =>
  new Promise((resolve, reject) =>
    httpRequest(url, (res) => (res.resume(), resolve({ status: res.statusCode, location: res.headers.location }))).on("error", reject).end(),
  );

// --- the API ----------------------------------------------------------------
{
  const res = await get(`${API}/health`, { headers: { "accept-encoding": "gzip, br, zstd" } });
  const body = await res.text();
  expect(res.status === 200 && body === '{"status":"ok"}', "GET /health answers 200 {\"status\":\"ok\"}", `${res.status} ${body}`);
  expect(res.headers.get("strict-transport-security") === HSTS, `API sends HSTS ${HSTS}`, res.headers.get("strict-transport-security"));
  expect(!res.headers.get("content-encoding"), "API compresses nothing, asked for gzip/br/zstd (Range and Content-Length stay true)", res.headers.get("content-encoding"));
  expect(!res.headers.get("server"), "API sends no Server header", res.headers.get("server"));
}
{
  // §11.8: no route answers HEAD, so a HEAD can never write an access-log row.
  const res = await get(`${API}/health`, { method: "HEAD" });
  expect(res.status >= 400, "HEAD /health is refused (monitors must use GET)", res.status);
}
{
  const res = await plain(`http://api.lirioapp.eu/health`);
  expect([301, 308].includes(res.status) && res.location?.startsWith("https://"), "plain HTTP on the API redirects to HTTPS", `${res.status} ${res.location}`);
}
{
  const preflight = (origin) =>
    get(`${API}/v1/login/params`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
  const ours = await preflight(APP);
  expect(ours.headers.get("access-control-allow-origin") === APP, `CORS admits exactly ${APP}`, ours.headers.get("access-control-allow-origin"));
  const theirs = await preflight("https://evil.example");
  expect(!theirs.headers.get("access-control-allow-origin"), "CORS admits no other origin", theirs.headers.get("access-control-allow-origin"));
}

// --- the app ----------------------------------------------------------------
const REQUIRED = {
  "content-security-policy": "frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "strict-transport-security": HSTS,
};
function headersOf(res, what) {
  for (const [name, value] of Object.entries(REQUIRED)) {
    expect(res.headers.get(name) === value, `${what}: ${name}: ${value}`, res.headers.get(name) ?? "absent");
  }
  expect(!res.headers.get("server"), `${what}: no Server header`, res.headers.get("server"));
}

const root = await get(`${APP}/`);
const html = await root.text();
expect(root.status === 200 && /text\/html/.test(root.headers.get("content-type") ?? ""), "GET / serves the HTML shell", root.status);
headersOf(root, "/");
const meta = /<meta http-equiv="content-security-policy" content="([^"]*)"/i.exec(html)?.[1] ?? "";
expect(/connect-src https:\/\/api\.lirioapp\.eu(;|$)/.test(meta), "the shell's CSP connects to the API and nothing else", meta.match(/connect-src[^;]*/)?.[0]);
expect(!html.includes("localhost"), "the shell mentions no localhost");

for (const path of ["/v/", "/some/deep/path"]) {
  const res = await get(`${APP}${path}`);
  const body = await res.text();
  expect(res.status === 200 && body === html, `${path} falls back to the same shell`, res.status);
  headersOf(res, path);
}

const asset = /(?:src|href)="(\/_app\/immutable\/[^"]+)"/.exec(html)?.[1];
if (asset) {
  const res = await get(`${APP}${asset}`);
  await res.arrayBuffer();
  expect(res.status === 200, `an immutable asset is served (${asset})`, res.status);
  headersOf(res, "asset");
} else bad("no /_app/immutable/ asset referenced by the shell");

{
  const res = await plain(`http://app.lirioapp.eu/`);
  expect([301, 308].includes(res.status) && res.location?.startsWith("https://"), "plain HTTP on the app redirects to HTTPS", `${res.status} ${res.location}`);
}

console.log(fails === 0 ? "\npublic: all PASS" : `\npublic: ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
