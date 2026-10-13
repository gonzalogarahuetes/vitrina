/*
 * §9.11's removal, over fake ports — api-sketch §9.11, §4.2, §7.3.
 * Hide first, erase second: the row is hidden before the store is touched, and
 * deleted only after both objects are confirmed absent with no upload in
 * flight. Every assertion below is about what the use case may REPORT, because
 * the one outcome this design exists to prevent is "erased" while ciphertext
 * is still in the store or can still land there.
 * Hermetic: no Postgres, no store, no HTTP.
 *
 * Expected export:
 *   removeMedia({ media, objectStore, confirmAttempts?, confirmDelayMs? })
 *     ({ mediaId, ownerId }) → Promise<
 *       { state: "erased" } | { state: "pending", failure?: unknown }>
 *   throwing ApplicationError("MEDIA_NOT_FOUND") for absent and not-yours.
 * `confirmAttempts` is how many HEADs a still-visible object gets before the
 * answer is `pending`; `confirmDelayMs` the wait between them. Both are test
 * seams with production defaults the composition root need not pass.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { removeMedia } from "../dist/application/use-cases/remove-media.js";
import { ApplicationError } from "../dist/application/errors.js";
import { StorageError } from "../dist/application/ports/object-store.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";
const MEDIA = "44444444-4444-4444-8444-444444444444";
const ASSET = `media/${MEDIA}/asset`;
const THUMB = `media/${MEDIA}/thumbnail`;

/**
 * One row, with the SQL's guards: `hide` matches on the owner and keeps the
 * first `removed_at`; `erase` deletes only a hidden row with nothing in
 * flight. `calls` is one log shared with the store, so order is assertable.
 */
function fakeMedia(calls, { inFlight = 0, ownerId = OWNER, hidden = false, lostRace = false } = {}) {
  const row = { id: MEDIA, ownerId, removedAt: hidden ? "earlier" : null, inFlight };
  let exists = true;
  return {
    row,
    get exists() {
      return exists;
    },
    async hide(mediaId, owner) {
      calls.push(`hide:${owner}`);
      if (!exists || mediaId !== row.id || owner !== row.ownerId) return null;
      row.removedAt ??= "now";
      return { id: row.id, uploadsInFlight: row.inFlight };
    },
    async erase(mediaId) {
      calls.push("erase");
      // The last upload out erased the row between this DELETE's HEADs and here.
      if (lostRace) exists = false;
      if (!exists || mediaId !== row.id || row.removedAt === null || row.inFlight !== 0) {
        return false;
      }
      exists = false;
      return true;
    },
  };
}

/**
 * The store as key → length. `removeFails` makes `remove` throw; `lingers`
 * makes `head` keep seeing a removed object for that many calls per key — a
 * store lagging behind its own delete. `on` narrows `lingers` and `headFails`
 * to some keys, so one object can disagree with the other.
 */
function fakeStore(
  calls,
  { removeFails = false, headFails = false, lingers = 0, on = [ASSET, THUMB] } = {},
) {
  const objects = new Map([
    [ASSET, 200],
    [THUMB, 100],
  ]);
  const ghosts = new Map(); // key → HEADs still to answer "present"
  return {
    objects,
    async remove(key) {
      calls.push(`remove:${key}`);
      if (removeFails) {
        throw new StorageError("UNAVAILABLE", { cause: new Error(`DELETE ${key}`) });
      }
      if (objects.has(key) && lingers > 0 && on.includes(key)) ghosts.set(key, lingers);
      objects.delete(key);
    },
    async head(key) {
      calls.push(`head:${key}`);
      if (headFails && on.includes(key)) {
        throw new StorageError("UNAVAILABLE", { cause: new Error(`HEAD ${key}`) });
      }
      const left = ghosts.get(key) ?? 0;
      if (left > 0) {
        ghosts.set(key, left - 1);
        return { length: 1 };
      }
      const length = objects.get(key);
      return length === undefined ? null : { length };
    },
  };
}

function subject(options = {}) {
  const calls = [];
  const media = fakeMedia(calls, options);
  const objectStore = fakeStore(calls, options);
  const remove = removeMedia({
    media,
    objectStore,
    confirmAttempts: options.confirmAttempts ?? 3,
    confirmDelayMs: 0,
  });
  return { calls, media, objectStore, remove };
}

const isNotFound = (error) => {
  assert.ok(error instanceof ApplicationError, `got ${error?.name}: ${error?.message}`);
  assert.equal(error.code, "MEDIA_NOT_FOUND");
  return true;
};

describe("removeMedia — §9.11", () => {
  it("hides before it touches the store, with the caller's owner id", async () => {
    // The owner's intent takes effect first, so a store failing partway still
    // leaves the photograph unserved and the erasure a retry.
    const { calls, remove } = subject();

    await remove({ mediaId: MEDIA, ownerId: OWNER });

    assert.equal(calls[0], `hide:${OWNER}`);
  });

  it("erases: removes both objects, confirms both absent, then deletes the row", async () => {
    const { calls, media, objectStore, remove } = subject();

    const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

    assert.deepEqual(outcome, { state: "erased" });
    assert.equal(objectStore.objects.size, 0);
    assert.equal(media.exists, false);

    // Both objects, then their confirmation, then the row — never the row
    // while an object might remain (§4.2).
    const at = (entry) => calls.indexOf(entry);
    for (const key of [ASSET, THUMB]) {
      assert.ok(at(`remove:${key}`) > at(`hide:${OWNER}`), `${key} removed before hide`);
      assert.ok(at(`head:${key}`) > at(`remove:${key}`), `${key} confirmed before removal`);
      assert.ok(at("erase") > calls.lastIndexOf(`head:${key}`), `row erased before ${key} confirmed`);
    }
  });

  describe("absent and not-yours are one answer (§7.3)", () => {
    it("is MEDIA_NOT_FOUND for another owner's row, which stays live", async () => {
      const { calls, media, objectStore, remove } = subject();

      await assert.rejects(() => remove({ mediaId: MEDIA, ownerId: OTHER_OWNER }), isNotFound);

      assert.equal(media.row.removedAt, null, "another owner's DELETE hid the row");
      assert.equal(objectStore.objects.size, 2);
      assert.deepEqual(calls, [`hide:${OTHER_OWNER}`], "the store or erase was reached");
    });

    it("is MEDIA_NOT_FOUND for an absent row, touching nothing", async () => {
      const { calls, remove } = subject();

      await assert.rejects(
        () => remove({ mediaId: "55555555-5555-4555-8555-555555555555", ownerId: OWNER }),
        isNotFound,
      );
      assert.deepEqual(calls, [`hide:${OWNER}`]);
    });

    it("is MEDIA_NOT_FOUND once erased — a repeated DELETE after a lost 204", async () => {
      // What lets a client retrying a lost response treat the second answer
      // as done: the row is gone only after its objects were confirmed gone.
      const { remove } = subject();
      await remove({ mediaId: MEDIA, ownerId: OWNER });

      await assert.rejects(() => remove({ mediaId: MEDIA, ownerId: OWNER }), isNotFound);
    });
  });

  describe("pending — hidden, erasure not yet confirmed", () => {
    // Each object is confirmed on its own: one absent says nothing about the
    // other. Both cases below were measured undetected by tests that moved the
    // two objects together.
    for (const [still, gone] of [[ASSET, THUMB], [THUMB, ASSET]]) {
      it(`one object still shown is pending, whichever it is — ${still.split("/")[2]}`, async () => {
        const { calls, media, remove } = subject({ lingers: 100, on: [still], confirmAttempts: 2 });

        const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

        assert.equal(outcome.state, "pending", `${gone} absent was taken for both`);
        assert.equal(media.exists, true);
        assert.ok(!calls.includes("erase"));
      });

      it(`one unreachable HEAD is pending, whichever it is — ${still.split("/")[2]}`, async () => {
        const { media, remove } = subject({ headFails: true, on: [still] });

        const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

        assert.equal(outcome.state, "pending");
        assert.ok(outcome.failure instanceof StorageError);
        assert.equal(media.exists, true);
      });
    }

    it("never erases while an upload is in flight", async () => {
      // The PUT that started before the hide may land after any delete issued
      // now. Erasing here would report a removal complete with ciphertext
      // still arriving.
      const { calls, media, remove } = subject({ inFlight: 1 });

      const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

      assert.equal(outcome.state, "pending");
      assert.equal(media.exists, true);
      assert.equal(media.row.removedAt, "now", "the row must be hidden even so");
      assert.ok(!calls.includes("erase"), "erase was attempted with an upload in flight");
    });

    it("an unreachable store on remove is pending, carries the cause, and keeps the row", async () => {
      const { media, remove } = subject({ removeFails: true });

      const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

      assert.equal(outcome.state, "pending");
      assert.ok(outcome.failure instanceof StorageError, "the route needs the cause to log it");
      assert.equal(media.exists, true);
      assert.equal(media.row.removedAt, "now");
    });

    it("an unreachable store on the confirming HEAD is pending, not erased", async () => {
      // A HEAD that could not answer is not a HEAD that answered "absent".
      const { calls, media, remove } = subject({ headFails: true });

      const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

      assert.equal(outcome.state, "pending");
      assert.ok(outcome.failure instanceof StorageError);
      assert.equal(media.exists, true);
      assert.ok(!calls.includes("erase"));
    });

    it("an object the store still shows is never reported erased", async () => {
      const { calls, media, remove } = subject({ lingers: 100, confirmAttempts: 3 });

      const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

      assert.equal(outcome.state, "pending");
      assert.equal(media.exists, true);
      assert.ok(!calls.includes("erase"));
    });

    it("a store lagging its own delete is asked again rather than believed", async () => {
      // One HEAD still sees the object, the next does not. A use case that
      // gives up on the first sighting answers 202 for a removal that
      // completed; one that ignores the sighting answers 204 too early.
      const { calls, media, remove } = subject({ lingers: 1, confirmAttempts: 3 });

      const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

      assert.deepEqual(outcome, { state: "erased" });
      assert.equal(media.exists, false);
      assert.ok(
        calls.filter((c) => c === `head:${ASSET}`).length >= 2,
        "the asset was HEADed once and the lag believed",
      );
    });
  });

  it("uses every attempt it is given — N attempts are N rounds of HEADs", async () => {
    // A store that shows the object for confirmAttempts - 1 rounds is
    // confirmed on the last one. An off-by-one in the loop answers 202 here.
    const { calls, media, remove } = subject({ lingers: 4, confirmAttempts: 5 });

    const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

    assert.deepEqual(outcome, { state: "erased" });
    assert.equal(media.exists, false);
    assert.equal(calls.filter((c) => c === `head:${ASSET}`).length, 5);
  });

  it("without the seams, production's defaults still retry a lagging store", async () => {
    /*
     * The composition root passes neither number. A default of 0 or 1 attempt
     * never reaches erase on a lagging store — or, with 0, never confirms at
     * all and answers 202 for every removal. Waits one real default delay.
     */
    const calls = [];
    const media = fakeMedia(calls);
    const objectStore = fakeStore(calls, { lingers: 1 });

    const outcome = await removeMedia({ media, objectStore })({ mediaId: MEDIA, ownerId: OWNER });

    assert.deepEqual(outcome, { state: "erased" });
    assert.equal(media.exists, false);
  });

  it("is MEDIA_NOT_FOUND when another erasure deleted the row first", async () => {
    // The last upload out and this retry both confirmed the objects absent;
    // the upload's erase won. Row already gone is done — the 404 §9.11 gives
    // a repeat — not erased by this request, and never 202 or 500.
    const { media, objectStore, remove } = subject({ lostRace: true });

    await assert.rejects(() => remove({ mediaId: MEDIA, ownerId: OWNER }), isNotFound);

    assert.equal(media.exists, false);
    assert.equal(objectStore.objects.size, 0);
  });

  it("resumes an erasure on a row already hidden", async () => {
    // A 202, then the client's retry: the second DELETE finds its own hidden
    // row and finishes the job.
    const { media, objectStore, remove } = subject({ hidden: true });

    const outcome = await remove({ mediaId: MEDIA, ownerId: OWNER });

    assert.deepEqual(outcome, { state: "erased" });
    assert.equal(media.exists, false);
    assert.equal(objectStore.objects.size, 0);
  });
});
