import init, * as envelope from "../wasm/envelope.js";
import { THRESHOLDS, unsetThresholds } from "./thresholds.js";

const logEl = document.getElementById("log");
const lines = [];
const t0 = performance.now();

function log(s) {
  lines.push(`${((performance.now() - t0) / 1000).toFixed(2)}s  ${s}`);
  logEl.textContent = lines.join("\n");
}

// Three failure modes look identical from outside: the tab was throttled, the
// tab was evicted and silently reloaded, or something threw. Detect each.
let maxGapMs = 0;
let busy = false;
let lastTick = performance.now();
// Synchronous WASM blocks the event loop, so yield between steps or the page
// never repaints and every gap looks like throttling.
const breathe = () => new Promise((r) => setTimeout(r, 16));
setInterval(() => {
  const now = performance.now();
  const gap = now - lastTick;
  lastTick = now;
  if (gap > 1000) {
    if (busy) {
      log(`   ${Math.round(gap)}ms main thread blocked by the measurement itself — not throttling`);
    } else {
      maxGapMs = Math.max(maxGapMs, gap);
      log(`!! ${Math.round(gap)}ms gap — tab throttled or suspended (visibility: ${document.visibilityState})`);
    }
  }
}, 250);
document.addEventListener("visibilitychange", () => log(`visibility: ${document.visibilityState}`));
window.addEventListener("error", (e) => log(`!! error: ${e.message}`));
window.addEventListener("unhandledrejection", (e) => log(`!! rejection: ${String(e.reason)}`));

try {
  const n = Number(sessionStorage.getItem("runs") ?? "0") + 1;
  sessionStorage.setItem("runs", String(n));
  if (n > 1) log(`!! PAGE LOAD #${n} — a reload here is how a tab is evicted for memory`);
} catch {
  log("sessionStorage unavailable: the reload detector is off");
}

function environment() {
  const c = navigator.connection ?? {};
  log(`ua: ${navigator.userAgent}`);
  log(
    `deviceMemory: ${navigator.deviceMemory ?? "?"} GiB · cores: ${navigator.hardwareConcurrency ?? "?"} · ` +
      `net: ${c.effectiveType ?? "?"} ${c.downlink ?? "?"}Mb/s · screen: ${screen.width}x${screen.height}@${devicePixelRatio}`,
  );
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(i + 65536, n)));
  return out;
}

const verdict = (ok, s) => log(`${ok ? "PASS" : "FAIL"} — ${s}`);

let env, album, manifest;

async function ready() {
  if (env) return;
  await init();
  env = envelope;
  environment();
  log(`chunkSize: ${envelope.chunkSize()} · albumKeyLen: ${envelope.albumKeyLen()}`);
}

async function fixtures() {
  if (manifest) return manifest;
  manifest = await (await fetch("./fixtures/manifest.json", { cache: "no-store" })).json();
  album = envelope.AlbumKey.fromBytes(unhex(manifest.albumKeyHex));
  log(`fixtures: ${manifest.assets.length} assets, ${manifest.thumbs.length} thumbnails`);
  return manifest;
}

function unhex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// A — exit criterion 3: the module loads in a browser and round-trips 3 MB.
async function measureA() {
  await ready();
  const plaintext = randomBytes(3 * 1024 * 1024);
  const assetId = randomBytes(envelope.assetIdLen());
  const key = envelope.AlbumKey.fromBytes(randomBytes(envelope.albumKeyLen()));
  busy = true;
  const t = performance.now();
  const object = envelope.encryptAsset(key, assetId, plaintext);
  const back = envelope.decryptAsset(key, assetId, object);
  const ms = performance.now() - t;
  busy = false;
  key.free();
  const same = back.length === plaintext.length && back.every((b, i) => b === plaintext[i]);
  log(`A · 3 MB round trip: ${Math.round(ms)}ms · object ${object.length} bytes · bytes match: ${same}`);
  verdict(same && ms <= THRESHOLDS.roundTrip3MbMaxMs, `A (limit ${THRESHOLDS.roundTrip3MbMaxMs}ms)`);
}

// B — V.1: Argon2id at §6.2's v1 parameters, every run reported. The first
// pays allocation, and on a constrained device the first is the failure.
async function measureB() {
  await ready();
  const key = envelope.AlbumKey.fromBytes(randomBytes(envelope.albumKeyLen()));
  const recipientId = randomBytes(envelope.recipientIdLen());
  const passphrase = "cafe roble nandu mesa faro";
  const times = [];
  for (let i = 0; i < THRESHOLDS.argon2Runs; i++) {
    const params = envelope.WrapParams.v1();
    busy = true;
    const t = performance.now();
    let wrapped;
    try {
      wrapped = envelope.wrapAlbumKey(key, passphrase, params, recipientId);
    } catch (e) {
      busy = false;
      log(`B · run ${i + 1}: THREW ${String(e)} — 64 MiB did not allocate, which §6.2 calls a spec change`);
      params.free();
      verdict(false, "B");
      key.free();
      return;
    }
    const ms = performance.now() - t;
    busy = false;
    times.push(ms);
    log(`B · wrap run ${i + 1}: ${Math.round(ms)}ms`);
    await breathe();
    if (i === 0) {
      const p2 = envelope.WrapParams.v1();
      busy = true;
      const tu = performance.now();
      const recovered = envelope.unwrapAlbumKey(passphrase, p2, recipientId, wrapped);
      busy = false;
      log(`B · unwrap: ${Math.round(performance.now() - tu)}ms (a second Argon2id run)`);
      await breathe();
      recovered.free();
      p2.free();
    }
    wrapped.free();
    params.free();
  }
  key.free();
  const worst = Math.max(...times);
  const best = Math.min(...times);
  log(`B · worst ${Math.round(worst)}ms · best ${Math.round(best)}ms`);
  if (worst > THRESHOLDS.argon2MaxMs) verdict(false, `B: above ${THRESHOLDS.argon2MaxMs}ms — v1 parameters must come down (§6.2 spec change)`);
  else if (worst < THRESHOLDS.argon2MinMs) verdict(true, `B: under ${THRESHOLDS.argon2MinMs}ms — parameters could go up`);
  else verdict(true, `B: inside [${THRESHOLDS.argon2MinMs}, ${THRESHOLDS.argon2MaxMs}]ms`);
}

// Renders one object, timing fetch, decrypt and render separately, so a slow
// result says which of the three to act on.
async function renderOne(entry, decrypt, into) {
  const tf = performance.now();
  const object = new Uint8Array(await (await fetch(`./fixtures/${entry.file}`, { cache: "no-store" })).arrayBuffer());
  const td = performance.now();
  const plaintext = decrypt(album, unhex(entry.assetIdHex), object);
  const tr = performance.now();
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([plaintext], { type: entry.type }));
  into.append(img);
  await img.decode();
  return { fetch: td - tf, decrypt: tr - td, render: performance.now() - tr };
}

// C — V.2: decrypt and render a full album. Blob URLs are deliberately not
// revoked; holding every image is the memory pressure being measured.
async function measureC() {
  await ready();
  await fixtures();
  const into = document.getElementById("album");
  into.replaceChildren();
  const sum = { fetch: 0, decrypt: 0, render: 0 };
  const t = performance.now();
  let done = 0;
  for (const entry of manifest.assets) {
    const p = await renderOne(entry, envelope.decryptAsset, into);
    for (const k of Object.keys(sum)) sum[k] += p[k];
    done++;
    log(`C · ${done}/${manifest.assets.length} · fetch ${Math.round(p.fetch)} decrypt ${Math.round(p.decrypt)} render ${Math.round(p.render)}ms`);
  }
  const ms = performance.now() - t;
  log(`C · total ${Math.round(ms)}ms · fetch ${Math.round(sum.fetch)} decrypt ${Math.round(sum.decrypt)} render ${Math.round(sum.render)}ms`);
  verdict(done === manifest.assets.length && done >= THRESHOLDS.albumMinAssets && ms <= THRESHOLDS.albumMaxMs, `C (${done} rendered, limit ${THRESHOLDS.albumMaxMs}ms)`);
}

// D — the thumbnail grid, twice. The server sends no-store, so the second
// pass measures whether the re-download brief §10.1 assumes actually happens.
async function measureD() {
  await ready();
  await fixtures();
  if (manifest.thumbs.length === 0) {
    log("D · SKIPPED: no thumbnails in the manifest");
    return;
  }
  const into = document.getElementById("grid");
  for (const pass of [1, 2]) {
    into.replaceChildren();
    const sum = { fetch: 0, decrypt: 0, render: 0 };
    const t = performance.now();
    for (const entry of manifest.thumbs) {
      const p = await renderOne(entry, envelope.decryptThumb, into);
      for (const k of Object.keys(sum)) sum[k] += p[k];
    }
    const ms = performance.now() - t;
    log(`D · pass ${pass}: total ${Math.round(ms)}ms · fetch ${Math.round(sum.fetch)} decrypt ${Math.round(sum.decrypt)} render ${Math.round(sum.render)}ms`);
    if (THRESHOLDS.thumbGridMaxMs !== null && ms > THRESHOLDS.thumbGridMaxMs) log(`D · above ${THRESHOLDS.thumbGridMaxMs}ms`);
  }
}

async function send() {
  const res = await fetch("/results", { method: "POST", body: lines.join("\n") + "\n" });
  log(`log posted to the laptop as device/results/${await res.text()}`);
}

const missing = unsetThresholds();
if (missing.length > 0) {
  logEl.textContent =
    `Refusing to run: these thresholds are unset in device/thresholds.js —\n  ${missing.join("\n  ")}\n\n` +
    `Decide them before the device is in your hand, or the result decides them for you.`;
} else {
  log("ready. thresholds: " + JSON.stringify(THRESHOLDS));
  const wrap = (f) => async () => {
    try {
      await f();
    } catch (e) {
      log(`!! ${String(e)}`);
    }
  };
  document.getElementById("a").onclick = wrap(measureA);
  document.getElementById("b").onclick = wrap(measureB);
  document.getElementById("c").onclick = wrap(measureC);
  document.getElementById("d").onclick = wrap(measureD);
  document.getElementById("send").onclick = wrap(send);
  document.getElementById("all").onclick = wrap(async () => {
    await measureA();
    await measureB();
    await measureC();
    await measureD();
    log(`max scheduler gap seen: ${Math.round(maxGapMs)}ms`);
    await send();
  });
}
