/*
 * §9.7's status ladder, over a fake ObjectStore — api-sketch §9.7, §9.3.
 * The evidence rule is the whole of this file: the server counted the bytes it
 * streamed, and the confirming HEADs are compared against THAT count and never
 * against anything a client declared.
 * Hermetic: no Postgres, no store, no HTTP.
 */

import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { uploadMediaObject } from "../dist/application/use-cases/upload-media-object.js";
import { StorageError } from "../dist/application/ports/object-store.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const ALBUM = "33333333-3333-4333-8333-333333333333";
const MEDIA = "44444444-4444-4444-8444-444444444444";

const at = (iso) => new Date(iso);

/**
 * The media port, in a Map, with §9.7's guards where the SQL has them:
 * `markReady` and `markFailed` write only from `processing`, and `beginUpload`
 * refuses `ready`. A fake without those guards passes tests the database would
 * fail, which is the point of putting them here.
 */
function inMemoryMedia({ status = "pending", ownerId = OWNER } = {}) {
  const row = {
    id: MEDIA,
    albumId: ALBUM,
    ownerId,
    kind: "photo",
    status,
    byteSize: null,
    createdAt: at("2026-09-26T09:00:00.000Z"),
    updatedAt: at("2026-09-26T09:00:00.000Z"),
  };
  const calls = [];
  return {
    row,
    calls,
    async findById(id) {
      calls.push(`findById:${id}`);
      return id === row.id ? { ...row } : null;
    },
    async beginUpload(id) {
      calls.push(`beginUpload:${id}`);
      if (id !== row.id) return null;
      if (row.status === "ready") return "already_ready";
      row.status = "processing";
      row.updatedAt = at("2026-09-26T09:00:01.000Z");
      return "started";
    },
    async markReady(id, byteSize) {
      calls.push(`markReady:${byteSize}`);
      if (row.status !== "processing") return; // the WHERE clause
      row.status = "ready";
      row.byteSize = byteSize;
    },
    async markFailed() {
      calls.push("markFailed");
      if (row.status !== "processing") return; // the WHERE clause
      row.status = "failed";
    },
  };
}

/**
 * The store, as a table of key → length. `heads` lets a test make one `HEAD`
 * throw or answer null without touching the rest.
 */
function fakeStore({ onPut, heads = {} } = {}) {
  const objects = new Map();
  const calls = [];
  return {
    objects,
    calls,
    async put(key, body, length) {
      calls.push(`put:${key}:${length}`);
      if (onPut) return onPut(key, body, length);
      let written = 0;
      for await (const chunk of body) written += chunk.length;
      objects.set(key, written);
    },
    async head(key) {
      calls.push(`head:${key}`);
      const override = heads[key];
      if (override === "throw") {
        throw new StorageError("UNAVAILABLE", { cause: new Error(`HEAD ${key}`) });
      }
      if (override === "absent") return null;
      if (typeof override === "number") return { length: override };
      const length = objects.get(key);
      return length === undefined ? null : { length };
    },
  };
}

const assetKey = `media/${MEDIA}/asset`;
const thumbKey = `media/${MEDIA}/thumbnail`;

const bodyOf = (bytes) => Readable.from([Buffer.alloc(bytes, 0x5a)]);

const run = (media, objectStore, overrides = {}) =>
  uploadMediaObject({ media, objectStore })({
    mediaId: MEDIA,
    ownerId: OWNER,
    variant: "asset",
    body: bodyOf(overrides.bytes ?? 1024),
    length: overrides.length ?? 1024,
    ...overrides.input,
  });

describe("uploadMediaObject — §9.3 scope", () => {
  it("throws MEDIA_NOT_FOUND for an unknown row", async () => {
    const media = inMemoryMedia();
    await assert.rejects(
      () =>
        uploadMediaObject({ media, objectStore: fakeStore() })({
          mediaId: "55555555-5555-4555-8555-555555555555",
          ownerId: OWNER,
          variant: "asset",
          body: bodyOf(1024),
          length: 1024,
        }),
      (error) => error.code === "MEDIA_NOT_FOUND",
    );
  });

  it("throws the same code for another owner's row", async () => {
    // Absent and not-yours are one answer — a `403` would confirm the row
    // exists, which is brief §9.1's leak in a status code.
    const media = inMemoryMedia({ ownerId: OTHER_OWNER });
    await assert.rejects(
      () => run(media, fakeStore()),
      (error) => error.code === "MEDIA_NOT_FOUND",
    );
  });

  it("writes nothing when the row is out of scope", async () => {
    const media = inMemoryMedia({ ownerId: OTHER_OWNER });
    const store = fakeStore();

    await run(media, store).catch(() => {});

    assert.deepEqual(store.calls, []);
    assert.equal(media.row.status, "pending", "the row must not have moved");
  });

  it("throws MEDIA_ALREADY_READY for a row that is ready", async () => {
    // §9.7's `409`, and the check "PUT is idempotent" removes: after `ready`,
    // replacing an object a recipient may be mid-fetch on is editing.
    const media = inMemoryMedia({ status: "ready" });
    await assert.rejects(
      () => run(media, fakeStore()),
      (error) => error.code === "MEDIA_ALREADY_READY",
    );
    assert.equal(media.row.status, "ready");
  });
});

describe("uploadMediaObject — §9.7's evidence", () => {
  it("compares the HEAD against what it counted, not what was declared", async () => {
    /*
     * The rule the whole section rests on. The body is 1024 bytes and the
     * declared length says 4096; the store reports what it actually received.
     * A use case that compared the HEAD against `input.length` would mark this
     * `ready`, and a client could then declare any size it liked.
     */
    const media = inMemoryMedia();
    const store = fakeStore();
    store.objects.set(thumbKey, 500);

    await run(media, store, { bytes: 1024, input: { length: 4096 } });

    assert.equal(media.row.status, "ready");
    assert.equal(media.row.byteSize, 1024 + 500, "the sum of the two HEAD lengths");
  });

  it("marks failed when the written object disagrees with the count", async () => {
    const media = inMemoryMedia();
    const store = fakeStore({ heads: { [assetKey]: 999 } });
    store.objects.set(thumbKey, 500);

    const outcome = await run(media, store);

    assert.equal(outcome.row.status, "failed");
    assert.equal(media.calls.includes("markReady:1499"), false);
  });

  it("leaves processing when the object just written is absent", async () => {
    /*
     * Ruled 25 September 2026: a `HEAD` cannot distinguish missing from not
     * yet visible, and that is as true of the object written two milliseconds
     * ago as of the other one. `failed` here would punish a slow store and ask
     * the client to re-send bytes that already landed.
     */
    const media = inMemoryMedia();
    const store = fakeStore({ heads: { [assetKey]: "absent" } });
    store.objects.set(thumbKey, 500);

    const outcome = await run(media, store);

    assert.equal(outcome.row.status, "processing");
    assert.equal(media.calls.includes("markFailed"), false);
  });

  it("leaves processing when the OTHER object is absent", async () => {
    // The ordinary case after one upload, and §6.2's named bug: a handler that
    // checked only what it just wrote would mark this `ready`.
    const media = inMemoryMedia();
    const store = fakeStore();

    const outcome = await run(media, store);

    assert.equal(outcome.row.status, "processing");
    assert.equal(outcome.row.byteSize, null);
  });

  it("reaches ready only once both objects are present", async () => {
    const media = inMemoryMedia();
    const store = fakeStore();

    const first = await run(media, store);
    assert.equal(first.row.status, "processing", "one object is not enough");

    store.objects.set(thumbKey, 700);
    media.row.status = "processing"; // a second upload would begin it again
    const second = await run(media, store);

    assert.equal(second.row.status, "ready");
    assert.equal(second.row.byteSize, 1024 + 700);
  });

  it("checks absent and wrong separately, in that order", async () => {
    /*
     * The branch order §9.7 fixes. With the other object legitimately absent
     * AND the written one wrong, a handler that tested `!written || !other`
     * first returns `processing` and never notices the bad object until a
     * second upload happens to reveal it.
     */
    const media = inMemoryMedia();
    const store = fakeStore({ heads: { [assetKey]: 999 } });

    const outcome = await run(media, store);

    assert.equal(outcome.row.status, "failed", "wrong beats absent-other");
  });
});

describe("uploadMediaObject — failures", () => {
  it("marks failed and reports the cause when put rejects", async () => {
    const cause = new StorageError("UNAVAILABLE", {
      cause: new Error("PUT media/... failed"),
    });
    const media = inMemoryMedia();
    const store = fakeStore({
      onPut: () => {
        throw cause;
      },
    });

    const outcome = await run(media, store);

    assert.equal(outcome.row.status, "failed");
    assert.equal(outcome.failure.kind, "upload");
    assert.equal(outcome.failure.cause, cause, "the real error, not a description");
  });

  it("leaves processing and reports the cause when a HEAD throws", async () => {
    /*
     * The upload succeeded — the bytes were written and counted — and what
     * failed is a confirmation the client did not ask for. A `failed` row here
     * would report an upload failure that did not happen.
     */
    const media = inMemoryMedia();
    const store = fakeStore({ heads: { [assetKey]: "throw" } });

    const outcome = await run(media, store);

    assert.equal(outcome.row.status, "processing");
    assert.equal(media.calls.includes("markFailed"), false);
    assert.equal(outcome.failure.kind, "confirmation");
    assert.ok(outcome.failure.cause instanceof StorageError);
  });

  it("returns the row as re-read, not as it was before the transition", async () => {
    // `markReady` and `markFailed` are guarded on `processing` and can no-op,
    // so the row's actual state is the only honest thing to report.
    const media = inMemoryMedia();
    const store = fakeStore();
    store.objects.set(thumbKey, 64);

    const outcome = await run(media, store);

    assert.equal(outcome.row.status, "ready");
    assert.notEqual(outcome.row.status, "pending", "the pre-read row said pending");
    assert.equal(media.calls.filter((c) => c.startsWith("findById")).length, 2);
  });

  it("writes to the key the variant names, and heads both", async () => {
    const media = inMemoryMedia();
    const store = fakeStore();

    await run(media, store, { input: { variant: "thumbnail" } });

    assert.ok(store.calls.includes(`put:${thumbKey}:1024`));
    assert.ok(store.calls.includes(`head:${thumbKey}`));
    assert.ok(store.calls.includes(`head:${assetKey}`), "the other object is read too");
  });
});
