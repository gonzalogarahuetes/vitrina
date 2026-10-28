/*
 * Where an upload's time goes, from Caddy's access log: every API request on
 * the media routes — preflights included — with how long Caddy held it and how
 * many body bytes it read. Run on the Mac, in two steps, because sudo's
 * password prompt is invisible once the output is piped (measured: it waited
 * silently for a password nobody knew it wanted):
 *
 *   ssh -t -i ~/.ssh/vitrina_hetzner <admin>@<ip> "sudo journalctl -u caddy --since '-24 hours' -o cat > caddy-access.log"
 *   ssh -i ~/.ssh/vitrina_hetzner <admin>@<ip> "cat caddy-access.log && rm caddy-access.log" | node deploy/release/request-timings.mjs
 *
 * Caddy's `duration` runs from the request's first byte to the response's
 * last, so for a PUT it includes the body's transfer from the phone AND the
 * API's write to the bucket. Ids are elided; nothing secret is in these lines
 * (Authorization and Cookie are deleted from them, verified in phase 5).
 */

import { createInterface } from "node:readline";

const rows = [];
for await (const line of createInterface({ input: process.stdin })) {
  let j;
  try {
    j = JSON.parse(line.slice(line.indexOf("{")));
  } catch {
    continue; // the sudo prompt, and anything else that is not a log line
  }
  const r = j.request;
  if (!r || r.host !== "api.lirioapp.eu" || !/\/v1\/(media|albums\/[^/]+\/media)/.test(r.uri)) continue;
  rows.push({
    at: new Date(j.ts * 1000).toISOString().slice(11, 19),
    method: r.method,
    route: r.uri.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "{id}"),
    status: j.status,
    ms: Math.round(j.duration * 1000),
    bytesIn: j.bytes_read ?? 0,
    proto: r.proto,
  });
}

if (rows.length === 0) {
  console.log("no media requests in that window — widen --since");
  process.exit(0);
}
for (const x of rows) {
  console.log(
    `${x.at}  ${x.method.padEnd(7)} ${x.route.padEnd(32)} ${String(x.status).padEnd(4)} ${String(x.ms).padStart(6)} ms ${String(x.bytesIn).padStart(9)} B in  ${x.proto}`,
  );
}

// Per kind of request: count, and the median and worst time.
const kinds = new Map();
for (const x of rows) {
  const k = `${x.method} ${x.route}`;
  (kinds.get(k) ?? kinds.set(k, []).get(k)).push(x);
}
console.log("\nper kind: count, median ms, worst ms, median KiB in");
for (const [k, xs] of kinds) {
  const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
  const kib = xs.map((x) => x.bytesIn / 1024).sort((a, b) => a - b);
  console.log(`  ${k.padEnd(40)} ${String(xs.length).padStart(3)} ${String(ms[ms.length >> 1]).padStart(7)} ${String(ms.at(-1)).padStart(7)} ${kib[kib.length >> 1].toFixed(0).padStart(7)}`);
}
