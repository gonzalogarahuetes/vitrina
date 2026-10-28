/*
 * §7.6's IP limiter behind a reverse proxy. `trustProxy: "loopback"` in
 * server.ts, asserted both ways, because each wrong setting passes half:
 *   - absent: every request from the proxy is 127.0.0.1, one budget for the
 *     world — the first case fails;
 *   - `true`: any peer's X-Forwarded-For is believed, a client picks its own
 *     key — the second and third cases fail.
 * Hermetic: app.inject, whose `remoteAddress` is the socket peer.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { OWNER_KDF_V1 } from "@vitrina/shared";

import { buildServer } from "../dist/adapters/driving/http/server.js";
import { buildUseCases } from "../dist/composition-root.js";
import { createCredentialHasher } from "../dist/adapters/driven/hashing/credential-hasher.js";
import { createTokenHasher } from "../dist/adapters/driven/hashing/token-hasher.js";

/** /login/params is the cheapest IP-limited route: always 200, a decoy for any address. */
async function buildTestServer() {
  const owners = {
    async findKdfByEmail() {
      return null;
    },
  };
  const useCases = buildUseCases(
    {
      owners,
      credentialHasher: createCredentialHasher(Buffer.alloc(32, 0x11)),
      tokenHasher: createTokenHasher(),
      clock: { now: () => new Date("2026-10-27T09:00:00.000Z") },
    },
    { kdfV1: OWNER_KDF_V1, dummyAuthHash: Buffer.alloc(32, 0x7f), allowList: new Set() /* only /login/params here: closed */ },
  );
  const app = await buildServer({ config: { clientOrigin: "http://localhost:5173" }, useCases, logger: false });
  await app.ready();
  return app;
}

const params = (app, { peer = "127.0.0.1", forwardedFor } = {}) =>
  app.inject({
    method: "POST",
    url: "/v1/login/params",
    remoteAddress: peer,
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
    payload: { email: "a@x.es" },
  });

/** The §7.6 budget is 10; returns the status of the 11th. */
async function eleventh(app, request) {
  for (let i = 0; i < 10; i++) assert.equal((await request(i)).statusCode, 200, `request ${i + 1} is inside the budget`);
  return (await request(10)).statusCode;
}

describe("§7.6 behind a loopback proxy — trustProxy", () => {
  it("keys on the forwarded client address when the peer is loopback: one client's lockout is not another's", async () => {
    const app = await buildTestServer();
    assert.equal(await eleventh(app, () => params(app, { forwardedFor: "203.0.113.1" })), 429);
    assert.equal(
      (await params(app, { forwardedFor: "203.0.113.2" })).statusCode,
      200,
      "a second client behind the same proxy shares the first one's budget",
    );
  });

  it("ignores X-Forwarded-For from a peer that is not loopback: rotating it does not buy a fresh budget", async () => {
    const app = await buildTestServer();
    const status = await eleventh(app, (i) => params(app, { peer: "198.51.100.7", forwardedFor: `203.0.113.${i + 10}` }));
    assert.equal(status, 429, "a direct client chose its own limiter key");
  });

  it("from the proxy, keys on the address the proxy saw, not on what the client prepended", async () => {
    const app = await buildTestServer();
    const status = await eleventh(app, (i) => params(app, { forwardedFor: `10.0.0.${i}, 203.0.113.50` }));
    assert.equal(status, 429, "client-supplied entries left of the proxy's own were believed");
  });

  it("with no proxy at all, a loopback client is still limited (local development)", async () => {
    const app = await buildTestServer();
    assert.equal(await eleventh(app, () => params(app)), 429);
  });
});
