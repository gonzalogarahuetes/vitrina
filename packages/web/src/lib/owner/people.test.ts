/*
 * Recipients and revoke (flows §3.9) and the access log (flows §3.10)
 * through the whole owner session, against the fake relay.
 */
import { encodeBase64url } from "@vitrina/shared";
import { describe, expect, it } from "vitest";
import { uuidToBytes } from "$lib/ids";
import type { LogScreen, PeopleScreen } from "./people";
import { ALBUM_A, PASSWORD, STORED, harness, labelBlob, routes, settle, type EntryFixture, type RecipientFixture } from "./harness.test-support";

type H = ReturnType<typeof harness>;

const MARIA = "f1000000-0000-4000-8000-000000000001";
const JUAN = "f2000000-0000-4000-8000-000000000002";
const LOST = "f3000000-0000-4000-8000-000000000003";
const PHOTO = "b1000000-0000-4000-8000-000000000001";
const HIDDEN = "b2000000-0000-4000-8000-000000000002";

function person(h: H, id: string, label: string | null, extra: Partial<RecipientFixture> = {}): void {
  h.recipients.set(id, {
    id,
    album: ALBUM_A,
    body: {},
    label: label === null ? encodeBase64url(new Uint8Array(48).fill(1)) : labelBlob(id, label),
    revoked_at: null,
    album_opens: 0,
    media_opened: 0,
    last_opened_at: null,
    ...extra,
  });
}

function seedPhoto(h: H, id: string): void {
  const seal = (kind: number, plain: Uint8Array) => Uint8Array.from([0xc7, kind, ...uuidToBytes(id), ...plain]);
  h.media.set(id, {
    id,
    album: ALBUM_A,
    status: "ready",
    created_at: "2026-10-10T09:00:00Z",
    updated_at: "2026-10-10T09:00:01Z",
    metadata: encodeBase64url(seal(3, new TextEncoder().encode(JSON.stringify({ width: 10, height: 10 })))),
    asset: seal(1, new Uint8Array([0xff, 0xd8, 1])),
    thumbnail: seal(2, new Uint8Array([0xff, 0xd8, 2])),
  });
}

async function inPeople(h: H): Promise<PeopleScreen> {
  h.session.start();
  await settle();
  h.session.submitUnlock(PASSWORD);
  await settle();
  h.session.openAlbum(ALBUM_A);
  await settle();
  h.session.openPeople();
  await settle();
  return people(h);
}

function people(h: H): PeopleScreen {
  const s = h.screen();
  if (s.kind !== "people") throw new Error(`not on the people screen: ${s.kind}`);
  return s;
}

function log(h: H): LogScreen {
  const s = h.screen();
  if (s.kind !== "log") throw new Error(`not on the log: ${s.kind}`);
  return s;
}

const entry = (id: number, recipient: string, media: string | null, at = "2026-10-12T10:00:00Z"): EntryFixture => ({
  id,
  recipient_id: recipient,
  media_id: media,
  event: media === null ? "album_opened" : "asset_viewed",
  occurred_at: at,
});

describe("invited people (flows §3.9)", () => {
  it("lists every recipient from the summary, labels opened, revoked ones marked, unreadable ones kept", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María", { album_opens: 3, media_opened: 2, last_opened_at: "2026-10-12T10:00:00Z" });
    person(h, JUAN, "Abuelo Juan", { revoked_at: "2026-10-13T08:00:00Z" });
    person(h, LOST, null);
    const s = await inPeople(h);
    expect(s.phase).toBe("ready");
    expect(s.people.map((p) => [p.id, p.label, p.revokedAt])).toEqual([
      [MARIA, "María", null],
      [JUAN, "Abuelo Juan", "2026-10-13T08:00:00Z"],
      [LOST, null, null],
    ]);
    expect(s.people[0]).toMatchObject({ albumOpens: 3, mediaOpened: 2, lastOpenedAt: "2026-10-12T10:00:00Z" });
    expect(routes(h.sent)).toContain(`GET /v1/albums/${ALBUM_A}/access-log`);
  });

  it("revoke: confirm first, then one POST with no body and no Content-Type, then marked revoked", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María");
    await inPeople(h);
    h.session.askRevoke(MARIA);
    expect(people(h).revoke).toEqual({ id: MARIA, busy: false, failed: false });
    expect(routes(h.sent).some((r) => r.includes("/revoke"))).toBe(false);
    h.session.confirmRevoke();
    await settle();
    const revoke = h.sent.filter((s) => s.url.endsWith(`/v1/recipients/${MARIA}/revoke`));
    expect(revoke).toHaveLength(1);
    expect(revoke[0]?.method).toBe("POST");
    expect(revoke[0]?.body).toBe("");
    expect(revoke[0]?.headers["content-type"]).toBeUndefined();
    expect(people(h)).toMatchObject({ revoke: null, justRevoked: MARIA });
    expect(people(h).people[0]?.revokedAt).toBe("2026-10-15T12:00:00Z");
  });

  it("is idempotent: a lost response is resent, and the resend's answer is success", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María");
    await inPeople(h);
    h.override(`POST /v1/recipients/${MARIA}/revoke`, "network");
    h.session.askRevoke(MARIA);
    h.session.confirmRevoke();
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(people(h).revoke?.busy).toBe(true);
    h.session.retryOffline();
    await settle();
    expect(people(h).people[0]?.revokedAt).not.toBeNull();
    expect(people(h).revoke).toBeNull();
  });

  it("a 404 means the screen is stale: the list is fetched again, and says so", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María");
    await inPeople(h);
    h.override(`POST /v1/recipients/${MARIA}/revoke`, { status: 404, json: { code: "NOT_FOUND", message: "x" } });
    h.session.askRevoke(MARIA);
    h.session.confirmRevoke();
    await settle();
    expect(routes(h.sent).filter((r) => r.endsWith("/access-log"))).toHaveLength(2);
    expect(people(h)).toMatchObject({ phase: "ready", refreshed: true, revoke: null, justRevoked: null });
  });

  it("another refusal leaves everything as it was, and can be tried again", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María");
    await inPeople(h);
    h.override(`POST /v1/recipients/${MARIA}/revoke`, { status: 400, json: { code: "VALIDATION_FAILED", message: "x" } });
    h.session.askRevoke(MARIA);
    h.session.confirmRevoke();
    await settle();
    expect(people(h).revoke).toEqual({ id: MARIA, busy: false, failed: true });
    expect(people(h).people[0]?.revokedAt).toBeNull();
    h.session.confirmRevoke();
    await settle();
    expect(people(h).people[0]?.revokedAt).not.toBeNull();
  });

  it("a revoked recipient cannot be revoked again, and leaving is refused while a revoke is in flight", async () => {
    const h = harness({ stored: STORED });
    person(h, JUAN, "Abuelo Juan", { revoked_at: "2026-10-13T08:00:00Z" });
    person(h, MARIA, "María");
    await inPeople(h);
    h.session.askRevoke(JUAN);
    expect(people(h).revoke).toBeNull();
    h.override(`POST /v1/recipients/${MARIA}/revoke`, "network");
    h.session.askRevoke(MARIA);
    h.session.confirmRevoke();
    await settle();
    h.session.leavePeople();
    expect(h.screen().kind).toBe("people");
  });

  it("back goes to the album, fetched afresh", async () => {
    const h = harness({ stored: STORED });
    await inPeople(h);
    h.session.leavePeople();
    await settle();
    expect(h.screen().kind).toBe("album");
  });
});

describe("the access log (flows §3.10)", () => {
  it("pages by next_before, newest first, filtered when asked, and draws each photo or its removed state", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María", { album_opens: 2 });
    seedPhoto(h, PHOTO);
    h.entries.push(entry(1, MARIA, null), entry(2, MARIA, PHOTO), entry(3, MARIA, HIDDEN), entry(4, MARIA, PHOTO), entry(5, MARIA, null));
    h.setPageSize(3);
    await inPeople(h);
    // The album fetched its thumbnails before; count only the log's.
    const since = h.sent.length;

    h.session.openLog(null);
    await settle();
    let l = log(h);
    expect(l.entries.map((e) => e.id)).toEqual([5, 4, 3]);
    expect(l.hasMore).toBe(true);
    expect(l.entries[0]).toMatchObject({ label: "María", event: "album_opened", mediaId: null });
    expect(l.photos[HIDDEN]).toEqual({ kind: "removed" });
    expect(l.photos[PHOTO]?.kind === "photo" && l.photos[PHOTO].thumb.kind).toBe("ready");
    const thumbFetches = () => routes(h.sent.slice(since)).filter((r) => r === `GET /v1/media/${PHOTO}/thumbnail`).length;
    expect(thumbFetches()).toBe(1);

    h.session.moreLog();
    await settle();
    l = log(h);
    expect(l.entries.map((e) => e.id)).toEqual([5, 4, 3, 2, 1]);
    expect(l.hasMore).toBe(false);
    expect(thumbFetches(), "one thumbnail per photo, not per entry").toBe(1);
    const pages = h.sent.filter((s) => new URL(s.url).pathname.endsWith("/access-log/entries")).map((s) => new URL(s.url).search);
    expect(pages).toEqual(["", "?before=3"]);
    expect(routes(h.sent).some((r) => r.endsWith("/asset")), "the log never fetches a full photo").toBe(false);
  });

  it("filters by recipient with recipient_id, and the title names them", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María", { album_opens: 1 });
    person(h, JUAN, "Abuelo Juan", { album_opens: 1 });
    h.entries.push(entry(1, JUAN, null), entry(2, MARIA, null));
    await inPeople(h);
    h.session.openLog(JUAN);
    await settle();
    expect(log(h)).toMatchObject({ recipientId: JUAN, recipientLabel: "Abuelo Juan" });
    expect(log(h).entries.map((e) => e.recipientId)).toEqual([JUAN]);
    const q = h.sent.filter((s) => s.url.includes("/access-log/entries")).map((s) => new URL(s.url).searchParams.get("recipient_id"));
    expect(q).toEqual([JUAN]);
  });

  it("a thumbnail that answers 404 is drawn as removed; closing the log closes every picture", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María", { album_opens: 1 });
    seedPhoto(h, PHOTO);
    seedPhoto(h, HIDDEN);
    h.entries.push(entry(1, MARIA, PHOTO), entry(2, MARIA, HIDDEN));
    await inPeople(h);
    // Removed after the album screen fetched it, and after the log fetched the album's details.
    h.override(`GET /v1/media/${HIDDEN}/thumbnail`, { status: 404, json: { code: "NOT_FOUND", message: "x" } });
    h.session.openLog(null);
    await settle();
    expect(log(h).photos[HIDDEN]).toEqual({ kind: "removed" });
    const pic = log(h).photos[PHOTO];
    h.session.closeLog();
    expect(h.screen().kind).toBe("people");
    expect(pic?.kind === "photo" && pic.thumb.kind === "ready" && (pic.thumb.picture as unknown as { closed: number }).closed).toBe(1);
  });

  it("an empty log is drawn as empty", async () => {
    const h = harness({ stored: STORED });
    person(h, MARIA, "María");
    await inPeople(h);
    h.session.openLog(null);
    await settle();
    expect(log(h)).toMatchObject({ phase: "ready", entries: [], hasMore: false });
  });
});
