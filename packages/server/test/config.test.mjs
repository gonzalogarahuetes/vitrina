/*
 * Boot validation — api-sketch §8.2, brief §6 #17. The secret absent or short
 * is a hard failure BEFORE the process listens, never a generated substitute:
 * generate-if-missing works perfectly on an empty deployment and destroys
 * login indistinguishability on every restart, with nothing failing.
 * Hermetic, against dist/.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../dist/config.js";

/** 32 bytes, base64url — the shortest secret that is allowed. */
const SECRET_32 = Buffer.alloc(32, 0x11).toString("base64url");

const env = (overrides = {}) => ({
  CLIENT_ORIGIN: "http://localhost:5173",
  VITRINA_SERVER_SECRET: SECRET_32,
  DATABASE_URL: "postgres://admin:password@localhost:5432/vitrina",
  ...overrides,
});

describe("loadConfig", () => {
  it("accepts a complete environment", () => {
    const config = loadConfig(env());

    assert.equal(config.clientOrigin, "http://localhost:5173");
    assert.equal(config.serverSecret.byteLength, 32);
    assert.match(config.databaseUrl, /^postgres:\/\//);
  });

  describe("the server secret", () => {
    it("absent is a hard failure", () => {
      assert.throws(() => loadConfig(env({ VITRINA_SERVER_SECRET: undefined })), /VITRINA_SERVER_SECRET/);
    });

    it("empty is a hard failure", () => {
      assert.throws(() => loadConfig(env({ VITRINA_SERVER_SECRET: "" })), /VITRINA_SERVER_SECRET/);
    });

    it("31 bytes is a hard failure", () => {
      // The boundary §8.2 names. 32 is the floor, not a suggestion.
      const short = Buffer.alloc(31, 0x11).toString("base64url");
      assert.throws(() => loadConfig(env({ VITRINA_SERVER_SECRET: short })), /31 bytes/);
    });

    it("longer than 32 bytes is fine", () => {
      const long = Buffer.alloc(64, 0x11).toString("base64url");
      assert.equal(loadConfig(env({ VITRINA_SERVER_SECRET: long })).serverSecret.byteLength, 64);
    });

    it("is refused when it is not base64url", () => {
      // Padded, or standard base64's + and /. One encoding, strictly decoded,
      // so the same decoder serves this and schema §6's tokens.
      for (const raw of ["a+b/c===", "not base64!", `${SECRET_32}=`]) {
        assert.throws(() => loadConfig(env({ VITRINA_SERVER_SECRET: raw })), /base64url|bytes/);
      }
    });

    it("never invents one when the variable is missing", () => {
      // The whole point of the row: a generated substitute leaves the property
      // silently absent, which is the failure #17 exists to name.
      let config;
      try {
        config = loadConfig(env({ VITRINA_SERVER_SECRET: undefined }));
      } catch {
        return; // threw, as required
      }
      assert.fail(`loadConfig invented a ${config.serverSecret.byteLength}-byte secret`);
    });
  });

  describe("the other required variables", () => {
    it("DATABASE_URL absent is a hard failure", () => {
      assert.throws(() => loadConfig(env({ DATABASE_URL: undefined })), /DATABASE_URL/);
    });

    it("CLIENT_ORIGIN absent is a hard failure", () => {
      assert.throws(() => loadConfig(env({ CLIENT_ORIGIN: undefined })), /CLIENT_ORIGIN/);
    });
  });
});
