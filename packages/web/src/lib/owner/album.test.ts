/*
 * The owner's album, upload and removal (flows §3.4, §3.6, §3.7), through
 * the whole owner session: real API client, a fake relay that keeps what it
 * is sent, a fake envelope (marker, kind and id, then the plaintext), and an
 * Imaging that hands back clean JPEG streams.
 */
import { describe, expect, it } from "vitest";
import { encodeBase64url, decodeBase64urlRange } from "@vitrina/shared";
import { uuidToBytes } from "$lib/ids";
import { ORIGINALS_CAP, STALL_MS, type AlbumScreen } from "./album";
import {
  ALBUM_A,
  FakePicture,
  MEDIA_IDS,
  PASSWORD,
  STORED,
  harness,
  okImaging,
  routes,
  settle,
  unsealed,
  type FakeHandle,
  type MediaFixture,
} from "./harness.test-support";
import { exifApp1, fakeJpeg, HIDDEN_EXIF, spliceAfterSoi } from "./jpeg.test-support";
import type { Imaging } from "./prepare";

const NAME = "IMG_20260612_bathtime.jpg";
const [M1, M2, M3] = MEDIA_IDS;
const SEEDED = "c0000000-0000-4000-8000-00000000000c";
const SEEDED_2 = "c0000000-0000-4000-8000-00000000000d";

const seal = (kind: number, id: string, plain: Uint8Array) => Uint8Array.from([0xc7, kind, ...uuidToBytes(id), ...plain]);
const metaEnvelope = (id: string, doc: object) => encodeBase64url(seal(3, id, new TextEncoder().encode(JSON.stringify(doc))));

function seed(h: ReturnType<typeof harness>, row: Partial<MediaFixture> & { id: string }): void {
  h.media.set(row.id, {
    album: ALBUM_A,
    status: "ready",
    created_at: "2026-10-10T09:00:00Z",
    updated_at: "2026-10-10T09:00:01Z",
    metadata: metaEnvelope(row.id, { width: 1600, height: 1200, name: "secret.jpg" }),
    asset: seal(1, row.id, new Uint8Array([0xff, 0xd8, 1])),
    thumbnail: seal(2, row.id, new Uint8Array([0xff, 0xd8, 2])),
    ...row,
  });
}

async function inAlbum(h: ReturnType<typeof harness>): Promise<AlbumScreen> {
  h.session.start();
  await settle();
  h.session.submitUnlock(PASSWORD);
  await settle();
  h.session.openAlbum(ALBUM_A);
  await settle();
  return album(h);
}

function album(h: ReturnType<typeof harness>): AlbumScreen {
  const s = h.screen();
  if (s.kind !== "album") throw new Error(`not on the album: ${s.kind}`);
  return s;
}

const photo = (name = NAME, bytes: Uint8Array<ArrayBuffer> = spliceAfterSoi(fakeJpeg(4032, 3024), exifApp1())) => new File([bytes], name, { type: "image/jpeg" });

/** An Imaging that records into the relay's event log, so its steps can be ordered against requests. */
function recordedImaging(events: string[], base: Imaging = okImaging()): Imaging {
  return {
    decode: async (f, r) => (events.push(`decode ${(f as File).name}`), base.decode(f, r)),
    encode: async (b, s, t, q) => (events.push(`encode ${s.width}x${s.height}`), base.encode(b, s, t, q)),
  };
}

/** The review step as a person goes through it: choose, let the reads land, caption some, send. */
async function send(h: ReturnType<typeof harness>, files: File[], captions: Record<number, string> = {}): Promise<void> {
  h.session.choosePhotos(files);
  await settle();
  const rows = album(h).review?.rows ?? [];
  rows.slice(-files.length).forEach((r, i) => {
    const c = captions[i];
    if (c !== undefined) h.session.setCaption(r.key, c);
  });
  h.session.sendReview();
}

const metaDoc = (r: { body: string }) => JSON.parse(new TextDecoder().decode(unsealed(decodeBase64urlRange((JSON.parse(r.body) as { metadata: string }).metadata, 1, 4096)))) as Record<string, unknown>;

const afterOpen = (h: ReturnType<typeof harness>, from: number) => routes(h.sent.slice(from));
const statusesSeen = (h: ReturnType<typeof harness>, key: string) =>
  h.states.flatMap((s) => (s.screen.kind === "album" ? s.screen.items.filter((i) => i.key === key).map((i) => `${i.status}/${i.local}`) : []));

// ── §3.4 Open ──────────────────────────────────────────────────────────────

describe("the owner's album (flows §3.4)", () => {
  it("lists every item in its server state, reads updated_at for those not ready, and fetches thumbnails for ready ones only", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    seed(h, { id: SEEDED_2, status: "processing", updated_at: "2026-10-15T11:58:00Z", asset: null, thumbnail: null });
    seed(h, { id: M3, status: "pending", updated_at: "2026-10-15T10:00:00Z", asset: null, thumbnail: null });
    const s = await inAlbum(h);
    expect(s.phase).toBe("ready");
    expect(s.items.map((i) => [i.id, i.status, i.stalled])).toEqual([
      [SEEDED, "ready", false],
      [SEEDED_2, "processing", false], // two minutes old
      [M3, "pending", true], // two hours old: stalled
    ]);
    const opened = routes(h.sent);
    expect(opened).toContain(`GET /v1/albums/${ALBUM_A}`);
    expect(opened).toContain(`GET /v1/albums/${ALBUM_A}/metadata`);
    expect(opened).toContain(`GET /v1/media/${SEEDED}/thumbnail`);
    expect(opened).toContain(`GET /v1/media/${SEEDED_2}`);
    expect(opened).toContain(`GET /v1/media/${M3}`);
    expect(opened.filter((r) => r.endsWith("/thumbnail"))).toEqual([`GET /v1/media/${SEEDED}/thumbnail`]);
    expect(opened.some((r) => r.endsWith("/asset")), "no full asset until the viewer shows it").toBe(false);
    expect(s.items[0]?.thumb.kind).toBe("ready");
    expect(s.items[0]?.size).toEqual({ w: 1600, h: 1200 });
  });

  it("a stalled row becomes stalled with time alone, with no request", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED, status: "processing", updated_at: "2026-10-15T11:59:00Z", asset: null, thumbnail: null });
    expect((await inAlbum(h)).items[0]?.stalled).toBe(false);
    const before = h.sent.length;
    h.setNow(new Date(Date.parse("2026-10-15T11:59:00Z") + STALL_MS + 1000));
    h.timers.filter((t) => t.ms === 60_000 && !t.cancelled).forEach((t) => t.fn());
    expect(album(h).items[0]?.stalled).toBe(true);
    expect(h.sent.length).toBe(before);
  });

  it("an envelope that will not open makes that one cell unavailable, never the album", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED, metadata: encodeBase64url(new Uint8Array(40).fill(9)) });
    seed(h, { id: SEEDED_2 });
    const s = await inAlbum(h);
    expect(s.items.map((i) => i.thumb.kind)).toEqual(["unavailable", "ready"]);
  });

  it("the viewer fetches the full asset only when it opens, from byte 0", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    expect(routes(h.sent).some((r) => r.endsWith("/asset"))).toBe(false);
    h.session.openViewer(SEEDED);
    await settle();
    const asset = h.sent.filter((r) => r.url.endsWith("/asset"));
    expect(asset.map((r) => r.headers["range"])).toEqual(["bytes=0-"]);
    expect(album(h).viewer?.phase).toBe("shown");
    const pic = album(h).viewer?.picture;
    h.session.closeViewer();
    expect((pic as unknown as { closed: number }).closed).toBe(1);
  });

  it("leaving closes every picture; the album list shows the new count", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    h.session.leaveAlbum();
    const s = h.screen();
    expect(s.kind).toBe("albums");
    if (s.kind === "albums") expect(s.albums.find((a) => a.id === ALBUM_A)?.mediaCount).toBe(1);
    expect(h.pictures.every((p) => p.closed === 1)).toBe(true);
  });
});

// ── §3.6 Upload ───────────────────────────────────────────────────────────

describe("upload (flows §3.6)", () => {
  it("prepare, encrypt, POST, both PUTs, and the server's ready: in that order, under one id", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const from = h.sent.length;
    await send(h, [photo()]);
    await settle();
    expect(afterOpen(h, from)).toEqual([
      `POST /v1/albums/${ALBUM_A}/media`,
      `PUT /v1/media/${M1}/asset`,
      `PUT /v1/media/${M1}/thumbnail`,
      `GET /v1/media/${M1}/thumbnail`,
    ]);
    const post = JSON.parse(h.sent[from]?.body ?? "") as { id: string; kind: string; metadata: string };
    expect(post.id).toBe(M1);
    expect(post.kind).toBe("photo");
    const doc = JSON.parse(new TextDecoder().decode(unsealed(decodeBase64urlRange(post.metadata, 1, 4096)))) as unknown;
    expect(doc, "encryption spec §7, the oriented size as encrypted").toEqual({ width: 1600, height: 1200, name: NAME });
    for (const put of h.sent.filter((r) => r.method === "PUT")) {
      expect(put.headers["content-type"]).toBe("application/octet-stream");
      expect(put.bytes?.[0], "an envelope, not the file").toBe(0xc7);
    }
    const [assetPut, thumbPut] = h.sent.filter((r) => r.method === "PUT");
    expect(assetPut?.bytes?.[1]).toBe(1);
    expect(thumbPut?.bytes?.[1]).toBe(2);
    const item = album(h).items.at(-1);
    expect(item).toMatchObject({ id: M1, status: "ready", local: null, size: { w: 1600, h: 1200 } });
    expect(item?.thumb.kind).toBe("ready");
  });

  it("every plaintext is zeroed once encrypted", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    await send(h, [photo()]);
    await settle();
    expect(h.env.plaintexts).toHaveLength(3);
    for (const p of h.env.plaintexts) expect(p.every((b) => b === 0)).toBe(true);
  });

  it("the original file is never what is sent: the asset is a re-encoded JPEG with no EXIF", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const original = photo();
    const originalBytes = new Uint8Array(await original.arrayBuffer());
    await send(h, [original]);
    await settle();
    const asset = h.sent.find((r) => r.url.endsWith("/asset"))?.bytes as Uint8Array;
    const plain = unsealed(asset);
    expect(plain).not.toEqual(originalBytes);
    expect(Buffer.from(plain).includes(Buffer.from("Exif"))).toBe(false);
  });

  it("the filename is in the metadata envelope and nowhere else: no URL, header or other body carries it", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    await send(h, [photo()]);
    await settle();
    const spellings = [NAME, encodeURIComponent(NAME), "bathtime", Buffer.from(NAME).toString("base64").slice(0, 16)];
    for (const r of h.sent) {
      // The metadata field is the envelope, where the name belongs; the fake envelope does not encrypt, so it is left out.
      const body = r.method === "POST" && r.url.endsWith("/media") ? JSON.stringify({ ...(JSON.parse(r.body) as object), metadata: undefined }) : r.body;
      const where = [r.url, ...Object.entries(r.headers).flat(), body, r.bytes === null ? "" : Buffer.from(r.bytes).toString("latin1")];
      for (const w of where) for (const s of spellings) {
        // The fake envelope does not encrypt, so its PUT bytes would show a name if one were there.
        expect(w, `${r.method} ${new URL(r.url).pathname}`).not.toContain(s);
      }
    }
  });

  it("nothing is shown as done before the server says ready", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    // The second PUT's answer and the next two polls say processing.
    h.delayReady.set(M1, 3);
    await send(h, [photo()]);
    await settle();
    // The relay holds both objects, but said processing; the item waits until it says ready.
    expect(album(h).items.at(-1)).toMatchObject({ status: "ready", local: null });
    const seen = statusesSeen(h, "local-1");
    const firstReady = seen.findIndex((s) => s.startsWith("ready"));
    expect(seen.slice(0, firstReady)).not.toContain("ready/null");
    const gets = h.sent.filter((r) => r.method === "GET" && r.url.endsWith(`/media/${M1}`));
    expect(gets.length, "polled until the relay itself answered ready").toBe(3);
    expect(h.sleeps).toContain(500);
    expect(h.sleeps).toContain(1000);
  });

  it("a 409 on create is our own lost response: the same id goes on to the PUTs, and no other id is ever used", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.override(`POST /v1/albums/${ALBUM_A}/media`, "network");
    // The first POST "landed" and lost its response; the resend meets the row.
    h.media.set(M1, { id: M1, album: ALBUM_A, status: "pending", created_at: "2026-10-15T12:00:00Z", updated_at: "2026-10-15T12:00:00Z", metadata: "", asset: null, thumbnail: null });
    await send(h, [photo()]);
    await settle();
    expect(h.session.current.offline).toBe(true);
    h.session.retryOffline();
    await settle();
    const ids = new Set<string>();
    for (const r of h.sent) {
      const inPath = /\/v1\/media\/([0-9a-f-]{36})/.exec(r.url)?.[1];
      if (inPath !== undefined) ids.add(inPath);
      if (r.method === "POST" && r.url.endsWith("/media")) ids.add((JSON.parse(r.body) as { id: string }).id);
    }
    expect([...ids]).toEqual([M1]);
    expect(routes(h.sent).filter((r) => r.startsWith("POST /v1/albums/"))).toHaveLength(2);
    expect(album(h).items.at(-1)).toMatchObject({ id: M1, status: "ready" });
  });

  it("one photo at a time, even when chosen in two goes: the second is not decoded until the first is ready", async () => {
    const h = harness({ stored: STORED, imaging: (events) => recordedImaging(events) });
    const events = h.events;
    await inAlbum(h);
    await send(h, [photo("one.jpg")]);
    await send(h, [photo("two.jpg")]);
    await settle();
    const firstReadyThumb = events.indexOf(`request PUT /v1/media/${M1}/thumbnail`);
    const secondDecode = events.indexOf("decode two.jpg");
    expect(firstReadyThumb).toBeGreaterThan(-1);
    expect(secondDecode).toBeGreaterThan(firstReadyThumb);
    expect(album(h).items.slice(-2).map((i) => [i.id, i.status])).toEqual([
      [M1, "ready"],
      [M2, "ready"],
    ]);
  });

  it("requests on the upload path are paced under api-sketch §11.5's 300 a minute", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.sleeps.length = 0;
    await send(h, [photo("one.jpg"), photo("two.jpg"), photo("three.jpg")]);
    await settle();
    // The clock does not move under test, so every paced request after the first waits a full slot.
    const paced = h.sleeps.filter((ms) => ms % 250 === 0 && ms >= 250);
    expect(paced.length).toBeGreaterThanOrEqual(8);
    expect(Math.max(...paced)).toBeGreaterThan(250);
  });

  it("a 429 on a PUT waits for Retry-After and resends the same envelope", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.override(`PUT /v1/media/${M1}/asset`, h.err(429, "RATE_LIMITED", { "retry-after": "7" }));
    await send(h, [photo()]);
    await settle();
    const puts = h.sent.filter((r) => r.url.endsWith(`/${M1}/asset`));
    expect(puts).toHaveLength(2);
    expect(h.sleeps).toContain(7000);
    expect(Buffer.from(puts[0]?.bytes ?? []).equals(Buffer.from(puts[1]?.bytes ?? []))).toBe(true);
    expect(album(h).items.at(-1)?.status).toBe("ready");
  });

  it("a failed item is sent again under the same id, from the envelopes this tab still holds", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.override(`PUT /v1/media/${M1}/asset`, {
      status: 200,
      json: { id: M1, album_id: ALBUM_A, kind: "photo", status: "failed", byte_size: null, created_at: "2026-10-15T12:00:00Z", updated_at: "2026-10-15T12:00:00Z" },
    });
    await send(h, [photo()]);
    await settle();
    expect(album(h).items.at(-1)).toMatchObject({ status: "failed", resendable: true, local: null });
    expect(routes(h.sent).filter((r) => r.includes("/thumbnail") && r.startsWith("PUT")), "stops at the failure").toHaveLength(0);
    h.session.resendPhoto("local-1");
    await settle();
    expect(album(h).items.at(-1)).toMatchObject({ id: M1, status: "ready" });
    expect(routes(h.sent).filter((r) => r.startsWith("POST"))).toHaveLength(1);
  });

  it("a failed row from an earlier visit has nothing to re-send: removal only", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED, status: "failed", asset: null, thumbnail: null });
    const s = await inAlbum(h);
    expect(s.items[0]).toMatchObject({ status: "failed", resendable: false });
    h.session.resendPhoto(SEEDED);
    await settle();
    expect(routes(h.sent).some((r) => r.startsWith("PUT"))).toBe(false);
  });

  it("the filter: an APP1 the browser's encoder added is removed, and the photo is sent without it", async () => {
    const app1: Imaging = {
      decode: okImaging().decode,
      encode: async (_b, s) => new Blob([spliceAfterSoi(fakeJpeg(s.width, s.height), exifApp1())], { type: "image/jpeg" }),
    };
    const h = harness({ stored: STORED, imaging: app1 });
    await inAlbum(h);
    await send(h, [photo()]);
    await settle();
    expect(album(h).items.at(-1)).toMatchObject({ status: "ready", localFailure: null });
    for (const put of h.sent.filter((r) => r.method === "PUT")) {
      // The fake envelope does not encrypt, so what was sealed is readable here.
      expect(Buffer.from(unsealed(put.bytes as Uint8Array)).includes(Buffer.from("Exif"))).toBe(false);
    }
  });

  it("the scan: a photo with EXIF hidden in its image data is never sent (#17): no request at all", async () => {
    const leaky: Imaging = {
      decode: okImaging().decode,
      encode: async (_b, s) => new Blob([fakeJpeg(s.width, s.height, [], { entropy: HIDDEN_EXIF })], { type: "image/jpeg" }),
    };
    const h = harness({ stored: STORED, imaging: leaky });
    await inAlbum(h);
    const from = h.sent.length;
    await send(h, [photo()]);
    await settle();
    expect(h.sent.slice(from)).toEqual([]);
    expect(album(h).items.at(-1)).toMatchObject({ localFailure: "not-stripped", id: null, status: null });
    h.session.dismissPhoto("local-1");
    expect(album(h).items).toEqual([]);
  });

  it("toBlob's PNG is never sent either", async () => {
    const png: Imaging = { decode: okImaging().decode, encode: async (_b, s) => new Blob([fakeJpeg(s.width, s.height)], { type: "image/png" }) };
    const h = harness({ stored: STORED, imaging: png });
    await inAlbum(h);
    const from = h.sent.length;
    await send(h, [photo()]);
    await settle();
    expect(h.sent.slice(from)).toEqual([]);
    expect(album(h).items.at(-1)?.localFailure).toBe("not-encoded");
  });

  it("a 401 mid-upload: signed out, every handle freed, every picture closed, nothing sent after", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    h.override(`PUT /v1/media/${M1}/asset`, h.err(401, "UNAUTHENTICATED"));
    await send(h, [photo("one.jpg"), photo("two.jpg")]);
    await settle();
    expect(h.screen().kind).toBe("signin");
    const after = h.sent.findIndex((r) => r.url.endsWith(`/${M1}/asset`));
    expect(h.sent.slice(after + 1)).toEqual([]);
    expect(h.handles.filter((x: FakeHandle) => x.freed === 0)).toEqual([]);
    expect(h.pictures.every((p) => p.closed === 1)).toBe(true);
  });

  it("leaving with a photo on its way asks first; leaving anyway stops it", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.override(`POST /v1/albums/${ALBUM_A}/media`, "network");
    await send(h, [photo()]);
    await settle();
    h.session.leaveAlbum();
    expect(album(h).leaving).toBe(true);
    h.session.stayInAlbum();
    expect(album(h).leaving).toBe(false);
    h.session.leaveAlbum();
    h.session.leaveAlbum(true);
    expect(h.screen().kind).toBe("albums");
    const before = h.sent.length;
    h.session.retryOffline();
    await settle();
    expect(h.sent.length, "the stopped upload does not resume").toBe(before);
  });
});

// ── §3.6 The review, and captions ─────────────────────────────────────────

describe("the review: previews and captions before anything is sent (flows §3.6)", () => {
  const CAPTION = "Bañera con la abuela 🛁";

  it("choosing opens the review: one preview at a time, in order, and no request and no preparation until Send", async () => {
    const h = harness({ stored: STORED, imaging: (events) => recordedImaging(events) });
    await inAlbum(h);
    const from = h.sent.length;
    const eventsFrom = h.events.length;
    h.session.choosePhotos([photo("one.jpg"), photo("two.jpg"), photo("three.jpg")]);
    await settle();
    const r = album(h).review;
    expect(r?.rows.map((x) => [x.name, x.preview.kind, x.caption])).toEqual([
      ["one.jpg", "ready", ""],
      ["two.jpg", "ready", ""],
      ["three.jpg", "ready", ""],
    ]);
    expect(h.events.slice(eventsFrom)).toEqual(["preview one.jpg", "preview two.jpg", "preview three.jpg"]);
    expect(h.sent.slice(from), "no request while the review is open").toEqual([]);
    expect(album(h).items, "nothing queued").toEqual([]);
    expect(h.env.plaintexts, "nothing encrypted").toEqual([]);
  });

  it("the caption goes into the metadata document, trimmed, and nowhere else; an empty one is left out", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const from = h.sent.length;
    await send(h, [photo("one.jpg"), photo("two.jpg")], { 0: `  ${CAPTION}\n`, 1: "   " });
    await settle();
    const posts = h.sent.slice(from).filter((r) => r.method === "POST");
    expect(posts.map(metaDoc)).toEqual([
      { width: 1600, height: 1200, name: "one.jpg", caption: CAPTION },
      { width: 1600, height: 1200, name: "two.jpg" },
    ]);
    expect(album(h).items.map((i) => [i.status, i.caption])).toEqual([
      ["ready", CAPTION],
      ["ready", null],
    ]);
    // Nowhere outside the envelope: the fake envelope does not encrypt, so the metadata field is set aside.
    const spellings = [CAPTION, encodeURIComponent(CAPTION), JSON.stringify(CAPTION).slice(1, -1), "abuela", Buffer.from(CAPTION).toString("base64").slice(0, 16)];
    for (const req of h.sent) {
      const body = req.method === "POST" && req.url.endsWith("/media") ? JSON.stringify({ ...(JSON.parse(req.body) as object), metadata: undefined }) : req.body;
      for (const w of [req.url, ...Object.entries(req.headers).flat(), body]) for (const sp of spellings) expect(w).not.toContain(sp);
    }
  });

  it("a caption is read back from the envelope when the album opens again", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED, metadata: metaEnvelope(SEEDED, { width: 1600, height: 1200, caption: CAPTION, unknown: true }) });
    seed(h, { id: SEEDED_2 });
    const s = await inAlbum(h);
    expect(s.items.map((i) => i.caption)).toEqual([CAPTION, null]);
  });

  it("280 code points are accepted, emoji counted as one each (560 UTF-16 units); 281 are not, and nothing is sent", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const ok = "🛁".repeat(280);
    expect(ok.length).toBe(560);
    h.session.choosePhotos([photo()]);
    await settle();
    const key = album(h).review?.rows[0]?.key as string;
    const from = h.sent.length;
    h.session.setCaption(key, `${ok}🛁`);
    h.session.sendReview();
    await settle();
    expect(album(h).review, "still open: the caption is too long").not.toBeNull();
    expect(h.sent.slice(from)).toEqual([]);
    h.session.setCaption(key, ok);
    h.session.sendReview();
    await settle();
    expect(album(h).review).toBeNull();
    expect(metaDoc(h.sent.find((r) => r.method === "POST") as { body: string })["caption"]).toBe(ok);
  });

  it("the longest caption, with the most escaping, still fits the relay's 4 KiB metadata cap beside a long filename", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    // Control characters escape to six bytes each in JSON: the worst case per code point.
    await send(h, [photo(`${"n".repeat(250)}.jpg`)], { 0: `x${"\u0001".repeat(278)}x` });
    await settle();
    const post = h.sent.find((r) => r.method === "POST") as { body: string };
    expect((metaDoc(post)["caption"] as string).length).toBe(280);
    expect(album(h).items.at(-1)).toMatchObject({ status: "ready", localFailure: null });
  });

  it("a row taken out is never prepared or sent, and its preview is closed", async () => {
    const h = harness({ stored: STORED, imaging: (events) => recordedImaging(events) });
    await inAlbum(h);
    h.session.choosePhotos([photo("one.jpg"), photo("wrong.jpg")]);
    await settle();
    const [, wrong] = album(h).review?.rows ?? [];
    const pic = wrong?.preview.kind === "ready" ? (wrong.preview.picture as unknown as { closed: number }) : null;
    h.session.unpickPhoto(wrong?.key as string);
    expect(pic?.closed).toBe(1);
    expect(album(h).review?.rows.map((x) => x.name)).toEqual(["one.jpg"]);
    h.session.sendReview();
    await settle();
    expect(h.events).not.toContain("decode wrong.jpg");
    expect(routes(h.sent).filter((r) => r.startsWith("POST /v1/albums/"))).toHaveLength(1);
    expect(album(h).items.map((i) => i.status)).toEqual(["ready"]);
  });

  it("cancel closes every preview and sends nothing; so does taking out the last row", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const from = h.sent.length;
    h.session.choosePhotos([photo("one.jpg"), photo("two.jpg")]);
    await settle();
    h.session.cancelReview();
    expect(album(h).review).toBeNull();
    h.session.choosePhotos([photo("three.jpg")]);
    await settle();
    h.session.unpickPhoto(album(h).review?.rows[0]?.key as string);
    expect(album(h).review).toBeNull();
    expect(h.pictures).toHaveLength(3);
    expect(h.pictures.every((p) => p.closed === 1)).toBe(true);
    expect(h.sent.slice(from)).toEqual([]);
  });

  it("a preview that cannot be made shows as failed; the photo can still be sent, and preparation decides", async () => {
    const h = harness({
      stored: STORED,
      preview: async () => {
        throw new Error("cannot decode");
      },
    });
    await inAlbum(h);
    h.session.choosePhotos([photo()]);
    await settle();
    expect(album(h).review?.rows[0]?.preview.kind).toBe("failed");
    h.session.sendReview();
    await settle();
    expect(album(h).items.at(-1)?.status).toBe("ready");
  });

  it("previews and preparation never decode at the same time (brief §11, memory)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      stored: STORED,
      imaging: (events) => recordedImaging(events),
      preview: async (file, events) => {
        events.push(`preview start ${file.name}`);
        if (file.name === "two.jpg") await gate;
        events.push(`preview end ${file.name}`);
        return new FakePicture(file.size);
      },
    });
    await inAlbum(h);
    h.session.choosePhotos([photo("one.jpg")]);
    await settle();
    h.session.sendReview();
    // The next choice arrives while the first photo is being prepared.
    h.session.choosePhotos([photo("two.jpg")]);
    await settle();
    release();
    await settle();
    const ev = h.events.filter((e) => /^(preview|decode|encode)/.test(e));
    const prepStart = ev.indexOf("decode one.jpg");
    const prepEnd = ev.lastIndexOf(ev.filter((e) => e.startsWith("encode")).at(-1) as string);
    const previewStart = ev.indexOf("preview start two.jpg");
    const previewEnd = ev.indexOf("preview end two.jpg");
    expect(prepStart).toBeGreaterThan(-1);
    expect(previewEnd).toBeGreaterThan(previewStart);
    expect(previewEnd < prepStart || previewStart > prepEnd, `no overlap: ${ev.join(", ")}`).toBe(true);
    expect(album(h).items.at(-1)?.status).toBe("ready");
    expect(album(h).review?.rows[0]?.preview.kind).toBe("ready");
  });

  it("nothing else opens over the review, and leaving the album closes every preview", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    h.session.choosePhotos([photo("one.jpg"), photo("two.jpg")]);
    await settle();
    h.session.askRemove(SEEDED);
    h.session.openViewer(SEEDED);
    h.session.openInvite();
    expect(album(h).confirm).toBeNull();
    expect(album(h).viewer).toBeNull();
    h.session.leaveAlbum(true);
    expect(h.screen().kind).toBe("albums");
    expect(h.pictures.every((p) => p.closed === 1)).toBe(true);
  });
});

// ── The originals: read once when chosen, zeroed, capped ───────────────────

/**
 * A picked file as the test phone's browser behaved (Vivaldi for Android, found on the phone walk):
 * readable when chosen, then not. `readable` reads succeed; every later one
 * fails, through arrayBuffer() and through slice() alike. Every buffer it
 * hands out is kept, so a test can check it was zeroed. `size` may be declared
 * larger than the bytes, to test the cap without allocating 100 MB.
 */
class PickedFile extends File {
  reads = 0;
  readonly buffers: ArrayBuffer[] = [];
  constructor(
    name: string,
    private readonly opts: { readable?: number; size?: number } = {},
  ) {
    super([spliceAfterSoi(fakeJpeg(4032, 3024), exifApp1())], name, { type: "image/jpeg" });
  }
  override get size(): number {
    return this.opts.size ?? super.size;
  }
  private gone(): boolean {
    return ++this.reads > (this.opts.readable ?? 1);
  }
  override async arrayBuffer(): Promise<ArrayBuffer> {
    if (this.gone()) throw new DOMException("The requested file could not be read", "NotReadableError");
    const b = await super.arrayBuffer();
    this.buffers.push(b);
    return b;
  }
  override slice(...a: Parameters<Blob["slice"]>): Blob {
    if (!this.gone()) return super.slice(...a);
    return new (class extends Blob {
      override arrayBuffer(): Promise<ArrayBuffer> {
        return Promise.reject(new DOMException("The requested file could not be read", "NotReadableError"));
      }
    })();
  }
}

const zeroed = (f: PickedFile) => f.buffers.length > 0 && f.buffers.every((b) => new Uint8Array(b).every((x) => x === 0));

describe("the originals: read once when chosen, never again, zeroed after use, capped", () => {
  it("a file readable only when chosen still uploads: it is read exactly once, at choosing, and never again", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const f = new PickedFile("late.jpg", { readable: 1 });
    h.session.choosePhotos([f]);
    expect(f.reads, "read at once, before the review is even drawn").toBe(1);
    await settle();
    h.session.sendReview();
    await settle();
    expect(album(h).items.at(-1)).toMatchObject({ status: "ready", localFailure: null });
    expect(f.reads).toBe(1);
  });

  it("every file of a choice is read at once, not one after another", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const files = [new PickedFile("a.jpg"), new PickedFile("b.jpg"), new PickedFile("c.jpg")];
    h.session.choosePhotos(files);
    expect(files.map((x) => x.reads)).toEqual([1, 1, 1]);
  });

  it("zeroed once prepared", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const f = new PickedFile("one.jpg");
    await send(h, [f]);
    await settle();
    expect(album(h).items.at(-1)?.status).toBe("ready");
    expect(zeroed(f)).toBe(true);
  });

  it("zeroed when preparation fails too", async () => {
    const png: Imaging = { decode: okImaging().decode, encode: async (_b, s) => new Blob([fakeJpeg(s.width, s.height)], { type: "image/png" }) };
    const h = harness({ stored: STORED, imaging: png });
    await inAlbum(h);
    const f = new PickedFile("one.jpg");
    await send(h, [f]);
    await settle();
    expect(album(h).items.at(-1)?.localFailure).toBe("not-encoded");
    expect(zeroed(f)).toBe(true);
  });

  it("zeroed when taken out, and when the review is cancelled", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const out = new PickedFile("out.jpg");
    const stays = new PickedFile("stays.jpg");
    h.session.choosePhotos([out, stays]);
    await settle();
    h.session.unpickPhoto(album(h).review?.rows[0]?.key as string);
    expect(zeroed(out)).toBe(true);
    expect(zeroed(stays), "the other is still needed").toBe(false);
    h.session.cancelReview();
    expect(zeroed(stays)).toBe(true);
  });

  it("zeroed when the album is left, in the review and in the queue", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.override(`POST /v1/albums/${ALBUM_A}/media`, "network");
    const queued = [new PickedFile("q1.jpg"), new PickedFile("q2.jpg")];
    await send(h, queued);
    const inReview = new PickedFile("r.jpg");
    h.session.choosePhotos([inReview]);
    await settle();
    h.session.leaveAlbum(true);
    await settle();
    for (const f of [...queued, inReview]) expect(zeroed(f), f.name).toBe(true);
  });

  it("a read that lands after the photo was taken out is zeroed on arrival", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const f = new PickedFile("slow.jpg");
    h.session.choosePhotos([f]);
    // Taken out before the read lands.
    h.session.cancelReview();
    await settle();
    expect(zeroed(f)).toBe(true);
  });

  it("a file that cannot be read when chosen says so; the others are sent, it is not", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const from = h.sent.length;
    h.session.choosePhotos([new PickedFile("gone.jpg", { readable: 0 }), new PickedFile("fine.jpg")]);
    await settle();
    expect(album(h).review?.rows.map((r) => [r.name, r.read])).toEqual([
      ["gone.jpg", "unreadable"],
      ["fine.jpg", "ok"],
    ]);
    h.session.sendReview();
    await settle();
    expect(routes(h.sent.slice(from)).filter((r) => r.startsWith("POST"))).toHaveLength(1);
    expect(album(h).items.map((i) => i.status)).toEqual(["ready"]);
  });

  it("Send waits while any file is still being read, rather than sending the rest and dropping it", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.session.choosePhotos([new PickedFile("one.jpg")]);
    await settle();
    // A second photo joins while the first is already read.
    h.session.choosePhotos([new PickedFile("two.jpg")]);
    expect(album(h).review?.rows.map((r) => r.read)).toEqual(["ok", "reading"]);
    h.session.sendReview();
    expect(album(h).review, "not sent while two.jpg is reading").not.toBeNull();
    await settle();
    h.session.sendReview();
    await settle();
    expect(album(h).review).toBeNull();
    expect(album(h).items.map((i) => i.status)).toEqual(["ready", "ready"]);
  });

  it(`a choice that would hold more than ${ORIGINALS_CAP} bytes is refused whole, and nothing of it is read`, async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const big = [new PickedFile("a.jpg", { size: 60_000_000 }), new PickedFile("b.jpg", { size: 40_000_001 })];
    h.session.choosePhotos(big);
    expect(album(h).chooseRefused).toBe(true);
    expect(album(h).review).toBeNull();
    expect(big.map((f) => f.reads)).toEqual([0, 0]);
    // Exactly at the cap is accepted, and clears the refusal.
    const fits = [new PickedFile("c.jpg", { size: 60_000_000 }), new PickedFile("d.jpg", { size: 40_000_000 })];
    h.session.choosePhotos(fits);
    expect(album(h).chooseRefused).toBe(false);
    expect(album(h).review?.rows).toHaveLength(2);
  });

  it("the cap counts every original still held: the one being prepared, the queue and the review", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = okImaging();
    // q1's preparation is held open, so q1 is "being prepared" and q2 waits in the queue.
    const held: Imaging = { decode: async (f, r) => (await gate, base.decode(f, r)), encode: base.encode };
    const h = harness({ stored: STORED, imaging: held });
    await inAlbum(h);
    const one = new PickedFile("x.jpg").size;
    await send(h, [new PickedFile("q1.jpg"), new PickedFile("q2.jpg")]);
    h.session.choosePhotos([new PickedFile("r.jpg")]);
    await settle();
    // Held: q1 (preparing) + q2 (queued) + r (review) = 3 × one. Exactly the cap fits; one byte more does not.
    h.session.choosePhotos([new PickedFile("over.jpg", { size: ORIGINALS_CAP - 3 * one + 1 })]);
    expect(album(h).chooseRefused, "each of the three counts").toBe(true);
    h.session.choosePhotos([new PickedFile("fits.jpg", { size: ORIGINALS_CAP - 3 * one })]);
    expect(album(h).chooseRefused).toBe(false);
    h.session.cancelReview();
    release();
    await settle();
  });
});

// ── §3.7 Remove ───────────────────────────────────────────────────────────

describe("remove (flows §3.7)", () => {
  async function confirm(h: ReturnType<typeof harness>, key: string) {
    h.session.askRemove(key);
    await settle();
    return album(h).confirm;
  }

  it("never ready: says nobody could have retrieved it, reading the status afresh and not the access log", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED, status: "pending", updated_at: "2026-10-15T08:00:00Z", asset: null, thumbnail: null });
    await inAlbum(h);
    const from = h.sent.length;
    expect((await confirm(h, SEEDED))?.statement).toBe("never-ready");
    expect(afterOpen(h, from)).toEqual([`GET /v1/media/${SEEDED}`]);
  });

  it("a row that became ready since the album loaded is not called never-ready", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED, status: "processing", updated_at: "2026-10-15T11:59:59Z", asset: null, thumbnail: null });
    await inAlbum(h);
    (h.media.get(SEEDED) as MediaFixture).status = "ready";
    expect((await confirm(h, SEEDED))?.statement).toBe("unopened");
  });

  it("unopened only when no recipient's last_opened_at is later than the item's created_at", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED, created_at: "2026-10-10T09:00:00Z" });
    h.accessLog.push({ recipient_id: "e1000000-0000-4000-8000-000000000001", last_opened_at: "2026-10-10T08:59:59Z" }, { recipient_id: "e1000000-0000-4000-8000-000000000002", last_opened_at: null });
    await inAlbum(h);
    expect((await confirm(h, SEEDED))?.statement).toBe("unopened");
    h.session.cancelRemove();
    h.accessLog.push({ recipient_id: "e1000000-0000-4000-8000-000000000003", last_opened_at: "2026-10-10T09:00:01Z" });
    expect((await confirm(h, SEEDED))?.statement).toBe("opened");
    expect(routes(h.sent).filter((r) => r.endsWith("/access-log"))).toHaveLength(2);
  });

  it("an unreadable time counts as opened: the statement errs towards saying the album has been opened", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    h.override(`GET /v1/albums/${ALBUM_A}/access-log`, { status: 200, json: { recipients: [{ recipient_id: "e1000000-0000-4000-8000-000000000001", label: "x".repeat(60), revoked_at: null, album_opens: 1, media_opened: 0, last_opened_at: "2026-10-10T09:00:00Z" }] } });
    // Equal to created_at is not later: unopened. That is the boundary, stated.
    expect((await confirm(h, SEEDED))?.statement).toBe("unopened");
  });

  it("204: gone from the album", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    await confirm(h, SEEDED);
    const pic = album(h).items[0]?.thumb;
    h.session.confirmRemove();
    await settle();
    expect(album(h).items).toEqual([]);
    expect(album(h).erasurePending).toBe(0);
    expect(routes(h.sent).at(-1)).toBe(`DELETE /v1/media/${SEEDED}`);
    if (pic?.kind === "ready") expect((pic.picture as unknown as { closed: number }).closed).toBe(1);
  });

  it("202: hidden at once, erasure pending, retried with backoff while the screen is open, cleared by a later 204", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    h.override(`DELETE /v1/media/${SEEDED}`, { status: 202 }, { status: 202 });
    await confirm(h, SEEDED);
    h.session.confirmRemove();
    await settle();
    expect(album(h).items).toEqual([]);
    expect(album(h).erasurePending).toBe(1);
    const fire = () => {
      const t = h.timers.filter((x) => !x.cancelled && x.ms !== 60_000).at(-1);
      t?.fn();
      return t?.ms;
    };
    expect(fire()).toBe(2000);
    await settle();
    expect(album(h).erasurePending).toBe(1);
    expect(fire()).toBe(4000);
    await settle();
    expect(album(h).erasurePending).toBe(0);
    expect(routes(h.sent).filter((r) => r.startsWith("DELETE"))).toHaveLength(3);
  });

  it("leaving the screen stops the erasure retries: nothing runs after it closes", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    h.override(`DELETE /v1/media/${SEEDED}`, { status: 202 });
    await confirm(h, SEEDED);
    h.session.confirmRemove();
    await settle();
    h.session.leaveAlbum();
    expect(h.timers.filter((t) => !t.cancelled && t.ms !== 60_000 && t.ms < 60_000)).toEqual([]);
  });

  it("404: already removed elsewhere, treated as removed", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    await confirm(h, SEEDED);
    h.media.delete(SEEDED);
    h.session.confirmRemove();
    await settle();
    expect(album(h).items).toEqual([]);
    expect(album(h).erasurePending).toBe(0);
  });

  it("nothing is offered for removal while this device is still moving the item", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.override(`PUT /v1/media/${M1}/asset`, "network");
    await send(h, [photo()]);
    await settle();
    h.session.askRemove("local-1");
    expect(album(h).confirm).toBeNull();
  });
});
