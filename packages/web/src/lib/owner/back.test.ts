/*
 * The browser's Back on the owner path (lib/history.ts): the whole session
 * against the fake relay, with history followed into a fake session history.
 * After every step history sits at the session's depth, every entry holds
 * SvelteKit's keys and at most the marker, and the URL is never touched.
 */
import { encodeBase64url } from "@vitrina/shared";
import { describe, expect, it } from "vitest";
import { uuidToBytes } from "$lib/ids";
import { DEPTH_KEY } from "$lib/history";
import { FakeHistory, SVELTEKIT_STATE, follow } from "$lib/history.test-support";
import { fakeJpeg } from "./jpeg.test-support";
import { ALBUM_A, PASSWORD, STORED, harness, labelBlob, settle } from "./harness.test-support";

type H = ReturnType<typeof harness>;

const PHOTO = "b1000000-0000-4000-8000-000000000001";
const MARIA = "f1000000-0000-4000-8000-000000000001";

function seedPhoto(h: H): void {
  const seal = (kind: number, plain: Uint8Array) => Uint8Array.from([0xc7, kind, ...uuidToBytes(PHOTO), ...plain]);
  h.media.set(PHOTO, {
    id: PHOTO,
    album: ALBUM_A,
    status: "ready",
    created_at: "2026-10-10T09:00:00Z",
    updated_at: "2026-10-10T09:00:01Z",
    metadata: encodeBase64url(seal(3, new TextEncoder().encode(JSON.stringify({ width: 10, height: 10 })))),
    asset: seal(1, new Uint8Array([0xff, 0xd8, 1])),
    thumbnail: seal(2, new Uint8Array([0xff, 0xd8, 2])),
  });
}

function seedPerson(h: H): void {
  h.recipients.set(MARIA, {
    id: MARIA,
    album: ALBUM_A,
    body: {},
    label: labelBlob(MARIA, "María"),
    revoked_at: null,
    album_opens: 0,
    media_opened: 0,
    last_opened_at: null,
  });
}

/** An owner signed in, on the album list, with history followed. */
async function onList(history = new FakeHistory()) {
  const h = harness({ stored: STORED });
  seedPhoto(h);
  seedPerson(h);
  const f = follow(h.session, history);
  h.session.start();
  await settle();
  h.session.submitUnlock(PASSWORD);
  await settle();
  expect(h.screen().kind).toBe("albums");
  return { h, history: f.history };
}

/** The album's first item's key. */
function firstKey(h: H): string {
  const s = h.screen();
  if (s.kind !== "album") throw new Error(`not on the album: ${s.kind}`);
  return s.items[0]?.key ?? "";
}

type O = Awaited<ReturnType<typeof onList>>;

/** Where the screen is, and that history matches it. */
function at({ h, history }: O): string {
  expect(history.depth, `history's depth on ${h.screen().kind}`).toBe(h.session.depth);
  expect(history.onlyMarkers, "history.state holds nothing but SvelteKit's keys and the marker").toBe(true);
  const s = h.screen();
  if (s.kind === "album") return s.viewer !== null ? "viewer" : s.review !== null ? "review" : s.confirm !== null ? "remove" : s.leaving ? "album leaving?" : "album";
  if (s.kind === "invite") return s.leaving ? `invite ${s.step} leaving?` : `invite ${s.step}`;
  if (s.kind === "people") return s.revoke !== null ? (s.revoke.busy ? "revoking" : "revoke?") : "people";
  if (s.kind === "albums") return s.create === "closed" ? "albums" : `create ${s.create}`;
  if (s.kind === "unlock") return s.signingOut ? "unlock signout?" : "unlock";
  return s.kind;
}

async function back(o: O): Promise<string> {
  o.history.back();
  await settle();
  return at(o);
}

async function act(o: O, f: () => void): Promise<string> {
  f();
  await settle();
  return at(o);
}

const photo = () => new File([fakeJpeg(4032, 3024)], "IMG_1.jpg", { type: "image/jpeg" });

describe("Back goes up one screen, and leaves the app from the album list", () => {
  it("album list → album → viewer", async () => {
    const o = await onList();
    const { h } = o;
    expect(await act(o, () => h.session.openAlbum(ALBUM_A))).toBe("album");
    const key = firstKey(h);
    expect(await act(o, () => h.session.openViewer(key))).toBe("viewer");
    expect(o.history.depths).toEqual([0, 1, 2]);
    expect(await back(o)).toBe("album");
    expect(await back(o)).toBe("albums");
    expect(o.history.left).toBe(false);
    o.history.back();
    await settle();
    expect(o.history.left, "Back from the album list leaves the app").toBe(true);
  });

  it("album → review step: Back cancels the review, as its Cancel does", async () => {
    const o = await onList();
    await act(o, () => o.h.session.openAlbum(ALBUM_A));
    expect(await act(o, () => o.h.session.choosePhotos([photo()]))).toBe("review");
    expect(await back(o)).toBe("album");
    expect(await back(o)).toBe("albums");
  });

  it("album → invite → album → list", async () => {
    const o = await onList();
    await act(o, () => o.h.session.openAlbum(ALBUM_A));
    expect(await act(o, () => o.h.session.openInvite())).toBe("invite form");
    expect(o.history.depths).toEqual([0, 1, 2]);
    expect(await back(o)).toBe("album");
    expect(await back(o)).toBe("albums");
  });

  it("album → people → access log, and back up to the list", async () => {
    const o = await onList();
    await act(o, () => o.h.session.openAlbum(ALBUM_A));
    expect(await act(o, () => o.h.session.openPeople())).toBe("people");
    expect(await act(o, () => o.h.session.openLog(null))).toBe("log");
    expect(o.history.depths).toEqual([0, 1, 2, 3]);
    expect(await back(o)).toBe("people");
    expect(await back(o)).toBe("album");
    expect(await back(o)).toBe("albums");
  });

  it("the in-app back controls leave history where Back would", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    await act(o, () => h.session.openPeople());
    await act(o, () => h.session.openLog(null));
    expect(await act(o, () => h.session.closeLog())).toBe("people");
    expect(o.history.index).toBe(2);
    expect(await act(o, () => h.session.leavePeople())).toBe("album");
    expect(o.history.index).toBe(1);
    expect(await act(o, () => h.session.leaveAlbum())).toBe("albums");
    expect(o.history.index).toBe(0);
    o.history.back();
    await settle();
    expect(o.history.left).toBe(true);
  });
});

describe("open sheets close on Back, as their Cancel does", () => {
  it("create album", async () => {
    const o = await onList();
    expect(await act(o, () => o.h.session.openCreate())).toBe("create open");
    expect(await back(o)).toBe("albums");
  });

  it("remove", async () => {
    const o = await onList();
    await act(o, () => o.h.session.openAlbum(ALBUM_A));
    const key = firstKey(o.h);
    expect(await act(o, () => o.h.session.askRemove(key))).toBe("remove");
    expect(await back(o)).toBe("album");
    expect(o.h.media.has(PHOTO), "nothing was removed").toBe(true);
  });

  it("revoke", async () => {
    const o = await onList();
    await act(o, () => o.h.session.openAlbum(ALBUM_A));
    await act(o, () => o.h.session.openPeople());
    expect(await act(o, () => o.h.session.askRevoke(MARIA))).toBe("revoke?");
    expect(await back(o)).toBe("people");
    expect(o.h.recipients.get(MARIA)?.revoked_at).toBeNull();
    expect(await back(o)).toBe("album");
  });

  it("unlock's sign-out sheet: Back closes it and unlock stays; Back again leaves the app", async () => {
    const h = harness({ stored: STORED });
    const f = follow(h.session);
    const o = { h, history: f.history };
    h.session.start();
    await settle();
    expect(at(o)).toBe("unlock");
    expect(await act(o, () => h.session.askUnlockSignOut(true))).toBe("unlock signout?");
    expect(await back(o)).toBe("unlock");
    expect(h.storage.storage.getItem("vitrina:owner:token"), "nothing was signed out").not.toBeNull();
    o.history.back();
    await settle();
    expect(o.history.left).toBe(true);
  });
});

describe("Back goes through the same guards (flows §3.6, §3.8, §3.9)", () => {
  it("an upload in flight: Back asks and stays; Back closes the ask; Back asks again; leaving anyway goes to the list", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    h.override(`POST /v1/albums/${ALBUM_A}/media`, "network");
    await act(o, () => h.session.choosePhotos([photo()]));
    expect(await act(o, () => h.session.sendReview())).toBe("album");
    expect(await back(o), "asks, and stays").toBe("album leaving?");
    expect(o.history.depths).toEqual([0, 1, 2]);
    expect(await back(o), "Back is the ask's Stay").toBe("album");
    expect(await back(o)).toBe("album leaving?");
    expect(await act(o, () => h.session.leaveAlbum(true))).toBe("albums");
    expect(o.history.index).toBe(0);
  });

  it("the invite's share step: Back asks and stays; Back closes the ask; leaving once confirmed goes to the album", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    await act(o, () => h.session.openInvite());
    expect(await act(o, () => h.session.createInvite("María"))).toBe("invite share");
    const link = (h.screen() as { share: { link: string } }).share.link;
    expect(await back(o), "asks, never leaves at once").toBe("invite share leaving?");
    expect((h.screen() as { share: { link: string } }).share.link).toBe(link);
    expect(await back(o), "Back is the ask's Stay").toBe("invite share");
    expect(await back(o)).toBe("invite share leaving?");
    expect(await act(o, () => h.session.leaveInvite(true))).toBe("album");
    expect(o.history.index).toBe(1);
  });

  it("an invite being created: Back is refused, and the next Back tries again", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    await act(o, () => h.session.openInvite());
    h.override(`POST /v1/albums/${ALBUM_A}/recipients`, "network");
    expect(await act(o, () => h.session.createInvite("María"))).toBe("invite creating");
    expect(await back(o)).toBe("invite creating");
    expect(o.history.depths).toEqual([0, 1, 2]);
    expect(await back(o)).toBe("invite creating");
    h.session.retryOffline();
    await settle();
    expect(at(o)).toBe("invite share");
  });

  it("the derivation wait: Back is refused", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    await act(o, () => h.session.openInvite());
    await act(o, () => h.session.chooseInviteMode("passphrase"));
    h.session.createInvite("María");
    expect((h.screen() as { step: string }).step).toBe("deriving");
    h.session.back();
    expect((h.screen() as { step: string }).step).toBe("deriving");
    await settle();
    expect(at(o)).toBe("invite share");
  });

  it("a revoke in flight: Back is refused, and the next Back tries again", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    await act(o, () => h.session.openPeople());
    await act(o, () => h.session.askRevoke(MARIA));
    h.override(`POST /v1/recipients/${MARIA}/revoke`, "network");
    expect(await act(o, () => h.session.confirmRevoke())).toBe("revoking");
    expect(await back(o)).toBe("revoking");
    expect(o.history.depths).toEqual([0, 1, 2, 3]);
    expect(await back(o)).toBe("revoking");
  });

  it("a remove in flight: Back is refused", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    const key = firstKey(h);
    await act(o, () => h.session.askRemove(key));
    h.override(`DELETE /v1/media/${PHOTO}`, "network");
    await act(o, () => h.session.confirmRemove());
    expect(await back(o)).toBe("remove");
    expect(o.history.depths).toEqual([0, 1, 2]);
  });

  it("an album being created: Back is refused", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openCreate());
    h.override("POST /v1/albums", "network");
    expect(await act(o, () => h.session.createAlbum("Playa"))).toBe("create creating");
    expect(await back(o)).toBe("create creating");
    expect(o.history.depths).toEqual([0, 1]);
  });
});

describe("a Back that skips several levels at once (the history menu)", () => {
  it("two levels, both of which leave: access log → people → album", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    await act(o, () => h.session.openPeople());
    expect(await act(o, () => h.session.openLog(null))).toBe("log");
    o.history.jump(-2);
    await settle();
    expect(at(o)).toBe("album");
    expect(o.history.index).toBe(1);
    expect(await back(o)).toBe("albums");
  });

  it("two levels, the second of which asks first: the viewer closes, the album asks and stays", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    const key = firstKey(h);
    h.override(`POST /v1/albums/${ALBUM_A}/media`, "network");
    await act(o, () => h.session.choosePhotos([photo()]));
    expect(await act(o, () => h.session.sendReview())).toBe("album");
    expect(await act(o, () => h.session.openViewer(key))).toBe("viewer");
    expect(o.history.depths).toEqual([0, 1, 2]);
    o.history.jump(-2);
    await settle();
    expect(at(o), "the viewer closed, and leaving asked instead of leaving").toBe("album leaving?");
    expect(o.history.index, "history is back at the ask's depth").toBe(2);
    expect(await back(o), "the next Back is the ask's Stay").toBe("album");
    expect(await back(o)).toBe("album leaving?");
  });
});

describe("depth, not a growing stack", () => {
  it("the viewer opened and closed 20 times with its own controls, then one Back from the album lands on the list", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    const key = firstKey(h);
    for (let i = 0; i < 20; i++) {
      expect(await act(o, () => h.session.openViewer(key))).toBe("viewer");
      expect(await act(o, () => h.session.closeViewer())).toBe("album");
    }
    expect(o.history.entries.length).toBeLessThanOrEqual(3);
    expect(o.history.index).toBe(1);
    expect(await back(o)).toBe("albums");
    o.history.back();
    await settle();
    expect(o.history.left).toBe(true);
  });
});

describe("reload, Forward, and the end of a session", () => {
  it("a reload on the viewer starts at unlock, back at the top; Back then leaves the app", async () => {
    const before = await onList();
    await act(before, () => before.h.session.openAlbum(ALBUM_A));
    const key = firstKey(before.h);
    await act(before, () => before.h.session.openViewer(key));
    // The reload: the same entries, a new page and a new session.
    const history = new FakeHistory(before.history.entries, before.history.index);
    const h = harness({ stored: STORED });
    follow(h.session, history);
    h.session.start();
    await settle();
    const o = { h, history };
    expect(at(o)).toBe("unlock");
    expect(history.index).toBe(0);
    history.forward();
    await settle();
    expect(at(o), "Forward reopens nothing").toBe("unlock");
    h.session.submitUnlock(PASSWORD);
    await settle();
    expect(at(o)).toBe("albums");
    history.back();
    await settle();
    expect(history.left).toBe(true);
  });

  it("sign-out: Back leaves the app and reopens nothing", async () => {
    const o = await onList();
    expect(await act(o, () => o.h.session.logout("device"))).toBe("signin");
    o.history.forward();
    await settle();
    expect(at(o)).toBe("signin");
    o.history.back();
    await settle();
    expect(o.history.left).toBe(true);
  });

  it("a 401 from deep down: sign-in, at the top; Forward reopens nothing", async () => {
    const o = await onList();
    const { h } = o;
    await act(o, () => h.session.openAlbum(ALBUM_A));
    await act(o, () => h.session.openPeople());
    h.override(`GET /v1/albums/${ALBUM_A}/access-log/entries`, h.err(401, "UNAUTHENTICATED"));
    await act(o, () => h.session.openLog(null));
    expect(at(o)).toBe("signin");
    expect(o.history.index).toBe(0);
    o.history.forward();
    await settle();
    expect(at(o)).toBe("signin");
  });

  it("the marker is the depth alone, kept beside SvelteKit's own keys", async () => {
    const o = await onList();
    await act(o, () => o.h.session.openAlbum(ALBUM_A));
    expect(o.history.state).toEqual({ ...SVELTEKIT_STATE, [DEPTH_KEY]: 1 });
    expect(o.history.entries[0]).toEqual(SVELTEKIT_STATE);
  });
});
