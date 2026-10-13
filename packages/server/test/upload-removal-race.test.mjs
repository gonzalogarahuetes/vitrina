/*
 * §9.7's upload against §9.11's removal — the race between a PUT that started
 * before `removed_at` was set and the DELETE that set it.
 *
 * The answer is a counter: `beginUpload` admits an upload and counts it in one
 * statement, `endUpload` uncounts it once the store has answered the PUT, and
 * a removal erases only at zero. So this file asserts the two halves the
 * counter depends on: the decrement happens exactly once on every exit path
 * (a missed one makes the stuck `202` normal rather than rare), and an upload
 * that finishes onto a hidden row removes what it wrote and answers 404.
 * Hermetic: no Postgres, no store, no HTTP.
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { uploadMediaObject } from "../dist/application/use-cases/upload-media-object.js";
import { ApplicationError } from "../dist/application/errors.js";
import { StorageError } from "../dist/application/ports/object-store.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ALBUM = "33333333-3333-4333-8333-333333333333";
const MEDIA = "44444444-4444-4444-8444-444444444444";
const ASSET = `media/${MEDIA}/asset`;
const THUMB = `media/${MEDIA}/thumbnail`;

/**
 * The media port with §9.11's guards where the SQL has them: a hidden row is
 * invisible to `findById` and refused by `beginUpload`; `markReady` writes
 * only a live `processing` row; the counter cannot go below zero (the
 * migration's CHECK). `throwOn` makes one method throw, once.
 */
function fakeMedia(calls, { status = "pending", throwOn = null } = {}) {
  const row = {
    id: MEDIA,
    albumId: ALBUM,
    ownerId: OWNER,
    kind: "photo",
    status,
    byteSize: null,
    removedAt: null,
    inFlight: 0,
    createdAt: new Date("2026-10-09T09:00:00.000Z"),
    updatedAt: new Date("2026-10-09T09:00:00.000Z"),
  };
  const maybeThrow = (method) => {
    if (throwOn === method) {
      throwOn = null;
      throw new Error(`${method} failed`);
    }
  };
  const view = () => {
    const { removedAt, inFlight, ...rest } = row;
    return { ...rest };
  };
  return {
    row,
    hide() {
      row.removedAt = new Date("2026-10-09T09:00:05.000Z");
    },
    async findById(id) {
      calls.push("findById");
      maybeThrow("findById");
      return id === row.id && row.removedAt === null ? view() : null;
    },
    async beginUpload(id) {
      calls.push("beginUpload");
      if (id !== row.id || row.removedAt !== null) return null;
      if (row.status === "ready") return "already_ready";
      row.status = "processing";
      row.inFlight += 1;
      return "started";
    },
    async endUpload(id) {
      calls.push("endUpload");
      assert.equal(id, row.id);
      assert.ok(row.inFlight > 0, "endUpload without a matching started beginUpload");
      row.inFlight -= 1;
      return row.removedAt === null ? "live" : "removed";
    },
    async markReady(id, byteSize) {
      calls.push("markReady");
      maybeThrow("markReady");
      if (row.status !== "processing" || row.removedAt !== null) return;
      row.status = "ready";
      row.byteSize = byteSize;
    },
    async markFailed() {
      calls.push("markFailed");
      maybeThrow("markFailed");
      if (row.status !== "processing") return;
      row.status = "failed";
    },
  };
}

/** key → length. Hooks run inside the call, so a hide lands mid-request. */
function fakeStore(calls, { onPut, onHead, putFails, headFails, removeFails, heads = {} } = {}) {
  const objects = new Map();
  return {
    objects,
    async put(key, body) {
      calls.push(`put:${key}`);
      let written = 0;
      for await (const chunk of body) written += chunk.length;
      if (putFails) throw new StorageError("UNAVAILABLE", { cause: new Error(`PUT ${key}`) });
      objects.set(key, written);
      onPut?.(key);
    },
    async head(key) {
      calls.push(`head:${key}`);
      onHead?.(key);
      if (headFails) throw new StorageError("UNAVAILABLE", { cause: new Error(`HEAD ${key}`) });
      if (typeof heads[key] === "number") return { length: heads[key] };
      const length = objects.get(key);
      return length === undefined ? null : { length };
    },
    async remove(key) {
      calls.push(`remove:${key}`);
      if (removeFails) throw new StorageError("UNAVAILABLE", { cause: new Error(`DELETE ${key}`) });
      objects.delete(key);
    },
  };
}

const upload = (media, objectStore) =>
  uploadMediaObject({ media, objectStore })({
    mediaId: MEDIA,
    ownerId: OWNER,
    variant: "asset",
    body: Readable.from([Buffer.alloc(1024, 0x5a)]),
    length: 1024,
  });

const isNotFound = (error) => {
  // An ApplicationError, so the envelope answers 404. A plain Error here is
  // the 500 `throwOnNullRow` used to give, when nothing deleted a row.
  assert.ok(error instanceof ApplicationError, `got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, "MEDIA_NOT_FOUND");
  return true;
};

const count = (calls, entry) => calls.filter((c) => c === entry).length;

describe("§9.11 — an upload is refused once the row is hidden", () => {
  it("is 404 when the hide lands between the lookup and beginUpload, and writes nothing", async () => {
    // beginUpload's own guard, not findById's, is what closes this window.
    const calls = [];
    const media = fakeMedia(calls);
    const store = fakeStore(calls);
    const findById = media.findById;
    media.findById = async (id) => {
      const found = await findById(id);
      media.hide();
      return found;
    };

    await assert.rejects(() => upload(media, store), isNotFound);

    assert.equal(store.objects.size, 0);
    assert.ok(!calls.some((c) => c.startsWith("put:")), "the object was written");
    assert.equal(count(calls, "endUpload"), 0, "nothing was counted, so nothing is owed");
  });
});

describe("§9.11 — endUpload exactly once, after the store answered, on every exit path", () => {
  const paths = [
    ["reaches ready", { seed: { [THUMB]: 500 } }, "ready"],
    ["stays processing, other object absent", {}, "processing"],
    ["the store refuses the PUT", { store: { putFails: true } }, "failed"],
    ["the confirming HEAD is unreachable", { store: { headFails: true } }, "processing"],
    ["the HEAD disagrees with the count", { store: { heads: { [ASSET]: 999 } } }, "failed"],
  ];

  for (const [name, setup, status] of paths) {
    it(name, async () => {
      const calls = [];
      const media = fakeMedia(calls);
      const store = fakeStore(calls, setup.store);
      for (const [key, length] of Object.entries(setup.seed ?? {})) store.objects.set(key, length);

      const outcome = await upload(media, store);

      assert.equal(outcome.row.status, status, "the existing ladder moved");
      assert.equal(count(calls, "endUpload"), 1);
      assert.ok(
        calls.indexOf("endUpload") > calls.indexOf(`put:${ASSET}`),
        "decremented before the store answered the PUT — a removal could erase under it",
      );
      assert.equal(media.row.inFlight, 0);
    });
  }

  it("is not called for an upload that never started", async () => {
    // A `ready` row is 409 and was never counted, so nothing is owed — and a
    // decrement here would take the counter below zero (the CHECK).
    const calls = [];
    const media = fakeMedia(calls, { status: "ready" });

    await assert.rejects(() => upload(media, fakeStore(calls)));

    assert.equal(count(calls, "endUpload"), 0);
  });
});

describe("§9.11 — the counter returns to zero when something throws partway", () => {
  /*
   * The condition the in-flight design was approved on. A decrement that sits
   * on the happy path alone is skipped by any exception, and every such
   * exception then leaves a removal answering 202 indefinitely.
   */
  const throwing = [
    ["markFailed throws after the store refused the PUT", { putFails: true }, "markFailed"],
    ["markReady throws", {}, "markReady"],
    ["the re-read after the transition throws", {}, null],
  ];

  for (const [name, storeOptions, throwOn] of throwing) {
    it(name, async () => {
      const calls = [];
      const media = fakeMedia(calls, { throwOn });
      const store = fakeStore(calls, storeOptions);
      store.objects.set(THUMB, 500);
      if (throwOn === null) {
        // The lookup succeeds; every later read throws.
        const findById = media.findById;
        let reads = 0;
        media.findById = async (id) => {
          reads += 1;
          if (reads > 1) throw new Error("re-read failed");
          return findById(id);
        };
      }

      // Whether the use case rethrows or reports is §9.7's business, not this
      // file's (markReady's failure lands in the confirmation catch today).
      await upload(media, store).catch(() => {});

      assert.equal(media.row.inFlight, 0, "the counter is stuck above zero");
      assert.equal(count(calls, "endUpload"), 1);
    });
  }
});

describe("§9.11 — an upload that finishes onto a hidden row", () => {
  it("removes the object it wrote, never marks ready, and answers 404", async () => {
    /*
     * The race itself: the DELETE hid the row while the bytes were streaming.
     * The DELETE answered 202 (the counter was 1), so nothing will come back
     * for this object unless the client retries — the uploader is the one
     * party that knows it just landed.
     */
    const calls = [];
    const media = fakeMedia(calls);
    const store = fakeStore(calls, { onPut: () => media.hide() });
    store.objects.set(THUMB, 500);

    await assert.rejects(() => upload(media, store), isNotFound);

    assert.notEqual(media.row.status, "ready");
    assert.equal(store.objects.has(ASSET), false, "the late object is still in the store");
    assert.ok(calls.indexOf(`remove:${ASSET}`) > calls.indexOf(`put:${ASSET}`));
    assert.equal(media.row.inFlight, 0);
  });

  it("still answers 404, and still decrements, when that removal cannot reach the store", async () => {
    // The object stays until the owner's DELETE is retried — which, with the
    // counter back at zero, removes both objects and confirms them.
    const calls = [];
    const media = fakeMedia(calls);
    const store = fakeStore(calls, { onPut: () => media.hide(), removeFails: true });

    await assert.rejects(() => upload(media, store), isNotFound);

    assert.equal(media.row.inFlight, 0);
    assert.equal(count(calls, "endUpload"), 1);
  });

  it("is 404 when the hide lands after the last re-read, before endUpload", async () => {
    /*
     * The ladder has finished with a live row in hand and is about to return
     * §9.8's status object. Only `endUpload`'s "removed" knows otherwise, so
     * the 404 must come from there — measured: without it this answers 200
     * for a removed photograph, and no earlier test noticed.
     */
    const calls = [];
    const media = fakeMedia(calls);
    const store = fakeStore(calls);
    store.objects.set(THUMB, 500);
    const findById = media.findById;
    let reads = 0;
    media.findById = async (id) => {
      const found = await findById(id);
      reads += 1;
      if (reads > 1) media.hide(); // after the re-read has returned the live row
      return found;
    };

    await assert.rejects(() => upload(media, store), isNotFound);

    assert.equal(store.objects.has(ASSET), false, "the late object is still in the store");
    assert.equal(media.row.inFlight, 0);
  });

  it("is 404, not a 500, when the hide lands during the confirming HEAD", async () => {
    // `throwOnNullRow` was written when nothing deleted a row; a hidden row
    // now reads as null on the re-read, and that is a removal, not a broken
    // invariant.
    const calls = [];
    const media = fakeMedia(calls);
    const store = fakeStore(calls, { onHead: () => media.hide() });
    store.objects.set(THUMB, 500);

    await assert.rejects(() => upload(media, store), isNotFound);

    assert.notEqual(media.row.status, "ready");
    assert.equal(media.row.inFlight, 0);
  });
});
