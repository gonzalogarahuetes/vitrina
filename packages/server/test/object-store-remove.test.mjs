/*
 * `ObjectStore.remove`'s status-code decision — api-sketch §9.11, over a stub
 * S3 client. Hermetic: the adapter takes its client through the constructor,
 * so `send` can answer whatever a store might.
 *
 * Why hermetic when infra/object-store-adapter.test.mjs exists: SeaweedFS
 * answers 204 for an absent key, so against the real store the 404 branch is
 * never taken. That branch exists for a store that answers 404 (Hetzner is
 * unverified), where without it every DELETE retried after a partial erasure
 * would throw on the object already gone and the row would answer 202 for
 * good. This file is the only thing that runs it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createObjectStore } from "../dist/adapters/driven/s3/object-store.js";

const BUCKET = "vitrina-media";
const KEY = "media/44444444-4444-4444-8444-444444444444/asset";

/**
 * Shaped as the SDK's service exceptions are: an Error with a name and
 * `$metadata.httpStatusCode`, which is the field the adapter's `statusOf`
 * reads. `undefined` answers success.
 */
function stubClient(status) {
  const sent = [];
  return {
    sent,
    async send(command) {
      sent.push(command);
      if (status === undefined) return { $metadata: { httpStatusCode: 204 } };
      const error = new Error(`stubbed ${status}`);
      error.name = status === 404 ? "NoSuchKey" : "InternalError";
      error.$metadata = { httpStatusCode: status };
      throw error;
    },
  };
}

const rejectionOf = (promise) => promise.then(() => null, (caught) => caught);

describe("remove — §9.11, decided on the status code", () => {
  it("sends one DeleteObject for the key and bucket it was given", async () => {
    const client = stubClient();

    await createObjectStore(client, BUCKET).remove(KEY);

    assert.equal(client.sent.length, 1);
    assert.equal(client.sent[0].constructor.name, "DeleteObjectCommand");
    assert.deepEqual(client.sent[0].input, { Key: KEY, Bucket: BUCKET });
  });

  it("resolves on a 404 — absent is success, as the port requires", async () => {
    // Remove this branch from the adapter and the result is UNAVAILABLE.
    await createObjectStore(stubClient(404), BUCKET).remove(KEY);
  });

  it("throws UNAVAILABLE on a 500 — the 404 branch is not 'any error is success'", async () => {
    const error = await rejectionOf(createObjectStore(stubClient(500), BUCKET).remove(KEY));

    assert.ok(error, "a 500 resolved — the branch has been widened");
    assert.equal(error.name, "StorageError");
    assert.equal(error.code, "UNAVAILABLE");
    assert.equal(error.$metadata, undefined);
    assert.equal(error.cause?.$metadata, undefined);
  });

  it("throws UNAVAILABLE on a 403 — a narrowed bucket policy is not absence", async () => {
    // The same direction `head` takes: on a bucket with narrowed permissions
    // a missing object can answer 403, and reading that as success would
    // answer 204 over ciphertext nobody could see was still there.
    const error = await rejectionOf(createObjectStore(stubClient(403), BUCKET).remove(KEY));

    assert.equal(error?.code, "UNAVAILABLE");
  });
});
