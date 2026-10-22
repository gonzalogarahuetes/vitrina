/*
 * The owner's album, upload and removal (flows §3.4, §3.6, §3.7), through
 * the whole owner session: real API client, a fake relay that keeps what it
 * is sent, a fake envelope (marker, kind and id, then the plaintext), and an
 * Imaging that hands back clean JPEG streams.
 */
import { describe, expect, it } from "vitest";
import { encodeBase64url, decodeBase64urlRange } from "@vitrina/shared";
import { uuidToBytes } from "$lib/ids";
import { STALL_MS, type AlbumScreen } from "./album";
import {
  ALBUM_A,
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
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo()]);
    await settle();
    expect(h.env.plaintexts).toHaveLength(3);
    for (const p of h.env.plaintexts) expect(p.every((b) => b === 0)).toBe(true);
  });

  it("the original file is never what is sent: the asset is a re-encoded JPEG with no EXIF", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    const original = photo();
    const originalBytes = new Uint8Array(await original.arrayBuffer());
    h.session.addPhotos([original]);
    await settle();
    const asset = h.sent.find((r) => r.url.endsWith("/asset"))?.bytes as Uint8Array;
    const plain = unsealed(asset);
    expect(plain).not.toEqual(originalBytes);
    expect(Buffer.from(plain).includes(Buffer.from("Exif"))).toBe(false);
  });

  it("the filename is in the metadata envelope and nowhere else: no URL, header or other body carries it", async () => {
    const h = harness({ stored: STORED });
    await inAlbum(h);
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo("one.jpg")]);
    h.session.addPhotos([photo("two.jpg")]);
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
    h.session.addPhotos([photo("one.jpg"), photo("two.jpg"), photo("three.jpg")]);
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
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo()]);
    await settle();
    expect(h.sent.slice(from)).toEqual([]);
    expect(album(h).items.at(-1)?.localFailure).toBe("not-encoded");
  });

  it("a 401 mid-upload: signed out, every handle freed, every picture closed, nothing sent after", async () => {
    const h = harness({ stored: STORED });
    seed(h, { id: SEEDED });
    await inAlbum(h);
    h.override(`PUT /v1/media/${M1}/asset`, h.err(401, "UNAUTHENTICATED"));
    h.session.addPhotos([photo("one.jpg"), photo("two.jpg")]);
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
    h.session.addPhotos([photo()]);
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
    h.session.addPhotos([photo()]);
    await settle();
    h.session.askRemove("local-1");
    expect(album(h).confirm).toBeNull();
  });
});
