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
import { AsyncLocalStorage } from "node:async_hooks";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import { uploadMediaObject } from "../dist/application/use-cases/upload-media-object.js";
import { removeMedia } from "../dist/application/use-cases/remove-media.js";
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
 * migration's CHECK); `erase` deletes only a hidden row with nothing in
 * flight, and only once. `throwOn` makes one method throw, once.
 *
 * `hide` is the port's, and also what the tests call to land a removal
 * mid-request: its body runs synchronously up to the return, so a hook that
 * calls it without awaiting has hidden the row by the next line.
 */
function fakeMedia(calls, { status = "pending", throwOn = null, inFlight = 0 } = {}) {
  const row = {
    id: MEDIA,
    albumId: ALBUM,
    ownerId: OWNER,
    kind: "photo",
    status,
    byteSize: null,
    removedAt: null,
    inFlight,
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
  const media = {
    row,
    exists: true,
    eraseResults: [],
    async hide(id = row.id, owner = OWNER) {
      calls.push("hide");
      if (!media.exists || id !== row.id || owner !== row.ownerId) return null;
      row.removedAt ??= new Date("2026-10-09T09:00:05.000Z");
      return { id: row.id, uploadsInFlight: row.inFlight };
    },
    async erase(id) {
      calls.push("erase");
      const erased = media.exists && id === row.id && row.removedAt !== null && row.inFlight === 0;
      if (erased) media.exists = false;
      media.eraseResults.push(erased);
      return erased;
    },
    async findById(id) {
      calls.push("findById");
      maybeThrow("findById");
      return media.exists && id === row.id && row.removedAt === null ? view() : null;
    },
    async beginUpload(id) {
      calls.push("beginUpload");
      if (!media.exists || id !== row.id || row.removedAt !== null) return null;
      if (row.status === "ready") return "already_ready";
      row.status = "processing";
      row.inFlight += 1;
      return "started";
    },
    async endUpload(id) {
      calls.push("endUpload");
      assert.equal(id, row.id);
      // The port: no row is a broken invariant, and it throws.
      if (!media.exists) throw new Error("endUpload: no row, while this upload is counted");
      assert.ok(row.inFlight > 0, "endUpload without a matching started beginUpload");
      row.inFlight -= 1;
      return row.removedAt === null
        ? { state: "live" }
        : { state: "removed", uploadsInFlight: row.inFlight };
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
  return media;
}

/** key → length. Hooks run inside the call, so a hide lands mid-request. */
function fakeStore(
  calls,
  { onPut, onHead, onRemove, putFails, headFails, removeFails, heads = {} } = {},
) {
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
      await onRemove?.(key);
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
  /*
   * The DELETE that hid the row answered 202, because this upload was in
   * flight — and a 202 the client never retries would leave everything stored.
   * So the last upload out runs the erasure a DELETE runs: both objects,
   * confirmed absent, then the row. It answers 404 whatever happens.
   */
  it("the last one out erases both objects and the row, and answers 404", async () => {
    const calls = [];
    const media = fakeMedia(calls);
    const store = fakeStore(calls, { onPut: () => media.hide() });
    store.objects.set(THUMB, 500);

    await assert.rejects(() => upload(media, store), (error) => {
      isNotFound(error);
      assert.equal(error.cause, undefined, "a completed erasure is not a failure");
      return true;
    });

    assert.equal(store.objects.size, 0, "an object survived the last upload out");
    assert.equal(media.exists, false, "the row survived the last upload out");
    assert.equal(media.row.inFlight, 0);
    assert.ok(calls.indexOf("erase") > calls.lastIndexOf(`head:${THUMB}`), "erased before confirming");
  });

  it("is still the last one out when the hide lands after the ladder's last re-read", async () => {
    // The ladder holds a live row and is about to answer 200. Only endUpload
    // knows otherwise — measured: without its 404, a removed photograph got a
    // status object back.
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

    assert.equal(store.objects.size, 0);
    assert.equal(media.exists, false);
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

  it("one that is not the last out erases nothing, and answers 404", async () => {
    // Another upload of this row is still in flight; it can still land an
    // object, so an erasure now could be followed by ciphertext. It will be
    // the last one out.
    const calls = [];
    const media = fakeMedia(calls, { inFlight: 1 });
    const store = fakeStore(calls, { onPut: () => media.hide() });
    store.objects.set(THUMB, 500);

    await assert.rejects(() => upload(media, store), isNotFound);

    assert.equal(media.exists, true, "erased while another upload is in flight");
    assert.ok(!calls.includes("erase"));
    assert.equal(media.row.inFlight, 1, "this upload's count must still come off");
  });

  it("an erasure that cannot reach the store answers 404, carries the cause, and keeps the row", async () => {
    // Logged at `error` by the route — §9.11's level for the DELETE path's
    // unreachable store; media-removal-routes.test.mjs asserts the line.
    const calls = [];
    const media = fakeMedia(calls);
    const store = fakeStore(calls, { onPut: () => media.hide(), removeFails: true });
    store.objects.set(THUMB, 500);

    await assert.rejects(() => upload(media, store), (error) => {
      isNotFound(error);
      assert.ok(error.cause instanceof StorageError, `cause was ${error.cause}`);
      return true;
    });

    assert.equal(media.exists, true, "erased with the objects unconfirmed");
    assert.equal(media.row.removedAt !== null, true, "the row must stay hidden");
    assert.equal(media.row.inFlight, 0);
  });

  it("no row at endUpload is a broken invariant — a 500, not a 404", async () => {
    // This upload is still counted and erase refuses above zero, so the row
    // cannot be gone. Reading absence as "removed" would hide the bug.
    const calls = [];
    const media = fakeMedia(calls);
    const store = fakeStore(calls, { onPut: () => { media.exists = false; } });

    await assert.rejects(
      () => upload(media, store),
      (error) => !(error instanceof ApplicationError),
    );
  });
});

describe("§9.11 — the last upload out and a retried DELETE erase at once", () => {
  /*
   * The DELETE retry arrives after the last upload has decremented to zero, so
   * both run the erasure. Removing an object twice is harmless and `erase`'s
   * guard lets exactly one delete the row. The loser reads "row already gone"
   * as done: the upload answers 404 with no failure, and a DELETE that lost
   * answers 404, as §9.11 says for a repeat — never 202, never 500.
   *
   * Both orders, by holding whichever `erase` is called first until the other
   * has run.
   */
  // Which party each `erase` belongs to, so the loser's answer is checked
  // against what that party must say — not "404 or erased" from either.
  const party = new AsyncLocalStorage();
  const losers = new Set();

  for (const held of [1, 2]) {
    it(`exactly one erases, and the loser reports done — erase call ${held} held`, { timeout: 5000 }, async () => {
      const calls = [];
      const media = fakeMedia(calls);
      let deleting;
      let deleteRetry;
      const store = fakeStore(calls, {
        onPut: () => media.hide(),
        // On the upload's first removal — after its decrement to zero — the
        // DELETE retry arrives. Not awaited: the two run side by side.
        onRemove: () => {
          deleting ??= party.run("delete", () =>
            deleteRetry({ mediaId: MEDIA, ownerId: OWNER }).then(
              (outcome) => ({ outcome }),
              (error) => ({ error }),
            ),
          );
        },
      });
      deleteRetry = removeMedia({ media, objectStore: store, confirmAttempts: 3, confirmDelayMs: 0 });
      store.objects.set(THUMB, 500);

      // Hold erase call number `held` until the other one has run.
      const erase = media.erase;
      const erases = [];
      let n = 0;
      let release;
      const otherDone = new Promise((resolve) => { release = resolve; });
      media.erase = async (id) => {
        const me = ++n;
        if (me === held) await otherDone;
        const result = await erase(id);
        erases.push({ party: party.getStore(), result });
        if (me !== held) release();
        return result;
      };

      const uploaded = await party.run("upload", () =>
        upload(media, store).then(
          (outcome) => ({ outcome }),
          (error) => ({ error }),
        ),
      );
      const deleted = await deleting;

      assert.ok(deleted, "the DELETE retry never ran — the race was not set up");
      assert.equal(erases.length, 2, `both parties must reach erase: ${JSON.stringify(erases)}`);
      assert.deepEqual(erases.map((e) => e.result).sort(), [false, true], "exactly one erase deletes the row");
      assert.equal(media.exists, false);
      assert.equal(store.objects.size, 0);

      const loser = erases.find((e) => !e.result).party;
      losers.add(loser);

      // The upload answers 404 with no failure attached, won or lost.
      assert.ok(uploaded.error, "the upload answered something other than 404");
      isNotFound(uploaded.error);
      assert.equal(uploaded.error.cause, undefined, "losing the race is not a failure");

      // The DELETE answers by what happened to it: erased if it won, and the
      // 404 §9.11 gives a repeat if it lost — never `erased` for a row it did
      // not delete.
      if (loser === "delete") {
        assert.ok(deleted.error, `the losing DELETE answered ${JSON.stringify(deleted.outcome)}`);
        isNotFound(deleted.error);
      } else {
        assert.deepEqual(deleted.outcome, { state: "erased" });
      }
    });
  }

  it("between them, the two orders make each party lose once", () => {
    // Otherwise one party's losing branch is never run, and the test above
    // asserts it twice from the same side.
    assert.deepEqual([...losers].sort(), ["delete", "upload"]);
  });
});
