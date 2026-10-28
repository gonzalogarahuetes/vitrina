/*
 * A hung store does not hang a request — over the REAL client
 * (createS3Client) and adapter (createObjectStore), against a local socket
 * that accepts and never answers. Each wait is given in milliseconds so the
 * mechanism runs in seconds; the production numbers are the defaults.
 *
 * Verified by violation: dropping `throwOnRequestTimeout` from createS3Client
 * fails the four bounded cases on their test timeout — the SDK then logs a
 * warning and keeps waiting, which the "without" case shows directly.
 */

import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { S3Client } from "@aws-sdk/client-s3";

import { createS3Client } from "../dist/composition-root.js";
import { createObjectStore, verifyBucket } from "../dist/adapters/driven/s3/object-store.js";
import { StorageError } from "../dist/application/ports/object-store.js";

const PER_CALL_MS = 200;
/** Three attempts (the SDK's default retry) plus its backoff, with slack. */
const BOUND_MS = 3 * PER_CALL_MS + 2_500;
/** A case that hangs must fail, not stall the run. */
const CASE = { timeout: 2 * BOUND_MS };
const credentials = { accessKeyId: "a", secretAccessKey: "b" };

let blackHole;
let connections = 0;
let endpoint;
const sockets = new Set();
const clients = [];

before(async () => {
  blackHole = createTcpServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("data", () => {}); // read the request, answer nothing, ever
  });
  await new Promise((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${blackHole.address().port}`;
});

// Whatever is still waiting on the black hole would keep this file alive.
after(() => {
  for (const client of clients) client.destroy();
  for (const socket of sockets) socket.destroy();
  blackHole.close();
});

const storage = () => ({ endpoint, region: "x", bucket: "b", ...credentials });
const tracked = (client) => (clients.push(client), client);

async function rejectsUnavailableWithin(promise) {
  const started = Date.now();
  await assert.rejects(promise, (error) => error instanceof StorageError && error.code === "UNAVAILABLE");
  const took = Date.now() - started;
  assert.ok(took >= PER_CALL_MS, `answered in ${took} ms — nothing was waited for, so nothing was bounded`);
  assert.ok(took < BOUND_MS, `took ${took} ms against a bound of ${BOUND_MS}`);
}

describe("a store that accepts the connection and never answers", () => {
  for (const [name, call] of [
    ["head (§9.7's confirming HEAD)", (store) => store.head("media/x/asset")],
    ["get (§11.2, §11.3)", (store) => store.get("media/x/asset", { start: 0 })],
    ["remove (§9.11)", (store) => store.remove("media/x/asset")],
  ]) {
    it(`${name} rejects UNAVAILABLE within its bound`, CASE, async () => {
      connections = 0;
      const store = createObjectStore(tracked(createS3Client(storage())), "b", PER_CALL_MS);
      await rejectsUnavailableWithin(call(store));
      assert.equal(connections, 3, "the bound assumes the SDK's three attempts");
    });
  }

  it("the boot check rejects within its bound", CASE, async () => {
    await rejectsUnavailableWithin(verifyBucket(tracked(createS3Client(storage())), "b", endpoint, PER_CALL_MS));
  });

  it("without throwOnRequestTimeout the same per-call timeout bounds nothing", async () => {
    // The SDK's own behaviour, asserted because createS3Client depends on it.
    const bare = tracked(new S3Client({ endpoint, region: "x", credentials, forcePathStyle: true }));
    const store = createObjectStore(bare, "b", PER_CALL_MS);
    const outcome = await Promise.race([
      store.head("media/x/asset").then(() => "answered", () => "rejected"),
      sleep(BOUND_MS).then(() => "still waiting"),
    ]);
    assert.equal(outcome, "still waiting");
  });
});

describe("put is bounded by its signal — §9.7's deadline, owned by the route", () => {
  it("rejects UNAVAILABLE once the signal aborts, against a store that took the body and never answers", CASE, async () => {
    const store = createObjectStore(tracked(createS3Client(storage())), "b", PER_CALL_MS);
    const controller = new AbortController();
    const abortAt = 300;
    setTimeout(() => controller.abort(new Error("upload deadline")), abortAt);

    const started = Date.now();
    await assert.rejects(
      store.put("media/x/asset", Readable.from([Buffer.alloc(1024, 1)]), 1024, controller.signal),
      (error) => error instanceof StorageError && error.code === "UNAVAILABLE",
    );
    const took = Date.now() - started;
    assert.ok(took >= abortAt - 20, `rejected after ${took} ms, before the abort — something else bounded it`);
    assert.ok(took < abortAt + 1_000, `rejected ${took} ms after start, long after the abort at ${abortAt}`);
  });
});

describe("put is not bounded by the per-call timeout", () => {
  it("an upload that streams for longer than it still lands", CASE, async () => {
    // A PutObject's headers arrive after its body, so a per-call bound would
    // cut every upload slower than it. put's bound is §9.7's deadline.
    const store200 = createHttpServer((request, response) => {
      request.resume();
      request.on("end", () => response.writeHead(200, { ETag: '"e"' }).end());
    });
    await new Promise((resolve) => store200.listen(0, "127.0.0.1", resolve));
    try {
      const client = tracked(createS3Client({ ...storage(), endpoint: `http://127.0.0.1:${store200.address().port}` }));
      const store = createObjectStore(client, "b", PER_CALL_MS);
      const parts = 6;
      const body = Readable.from(
        (async function* () {
          for (let i = 0; i < parts; i++) {
            await sleep(PER_CALL_MS);
            yield Buffer.alloc(1024, i);
          }
        })(),
      );
      const started = Date.now();
      await store.put("media/x/asset", body, parts * 1024, new AbortController().signal);
      assert.ok(Date.now() - started > 3 * PER_CALL_MS, "the body did not outlast the per-call timeout");
    } finally {
      store200.closeAllConnections();
      store200.close();
    }
  });
});
