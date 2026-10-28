/*
 * consistency.mjs's decision, over fakes. The SQL and the bucket are
 * exercised by `rehearse.sh hide-missing`, against the real stack.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReadyMedia } from "../backup/media-check.mjs";

/** objects: Map("id/variant" → length); throwFor: an id whose HEAD is unreachable. */
function fakes(rows, objects, { throwFor } = {}) {
  const hidden = [];
  return {
    hidden,
    listReady: async () => rows,
    head: async (id, variant) => {
      if (id === throwFor) throw new Error("UNAVAILABLE");
      const length = objects.get(`${id}/${variant}`);
      return length === undefined ? null : { length };
    },
    hide: async (ids) => {
      hidden.push(...ids);
      return ids;
    },
  };
}

const ROWS = [
  { id: "whole", byteSize: "300" },
  { id: "no-thumb", byteSize: "300" },
  { id: "no-asset", byteSize: "300" },
  { id: "wrong-size", byteSize: "999" },
];
const OBJECTS = new Map([
  ["whole/asset", 200], ["whole/thumbnail", 100],
  ["no-thumb/asset", 200],
  ["no-asset/thumbnail", 100],
  ["wrong-size/asset", 200], ["wrong-size/thumbnail", 100],
]);

test("by default nothing is written; every absent object and mismatch is reported", async () => {
  const f = fakes(ROWS, OBJECTS);
  const r = await checkReadyMedia(f);
  assert.deepEqual(f.hidden, []);
  assert.deepEqual(r.missing, [{ id: "no-thumb", absent: ["thumbnail"] }, { id: "no-asset", absent: ["asset"] }]);
  assert.deepEqual(r.mismatched, [{ id: "wrong-size", objects: 300, row: 999 }]);
  assert.equal(r.checked, 4);
});

test("--hide-missing hides exactly the rows with an absent object — not a whole one, not a mismatch", async () => {
  const f = fakes(ROWS, OBJECTS);
  const r = await checkReadyMedia(f, { hideMissing: true });
  assert.deepEqual(f.hidden, ["no-thumb", "no-asset"]);
  assert.deepEqual(r.hidden, ["no-thumb", "no-asset"]);
});

test("--hide-missing hides nothing when the store cannot answer for any row", async () => {
  // Unreachable is not absent (§9.7): a blip must not hide photographs.
  const f = fakes(ROWS, OBJECTS, { throwFor: "wrong-size" });
  await assert.rejects(checkReadyMedia(f, { hideMissing: true }));
  assert.deepEqual(f.hidden, []);
});

test("--hide-missing with nothing missing calls hide not at all", async () => {
  const f = fakes([ROWS[0]], OBJECTS);
  await checkReadyMedia(f, { hideMissing: true });
  assert.deepEqual(f.hidden, []);
});
