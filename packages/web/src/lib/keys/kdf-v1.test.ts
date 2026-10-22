/*
 * The owner's v1 Argon2id parameters are written down in two places:
 * OWNER_KDF_V1 in @vitrina/shared, which signup derives with and posts, and
 * WrapParams::V1 in the crate (`WrapParams.v1()`). The spec's owner_wrap
 * vector (§6.6.2, category 17) is a third. If they drift, nothing else fails:
 * signup simply posts one set of parameters and some other path derives with
 * another.
 *
 * RECIPIENT_KDF_V1, the passphrase-invite parameters, is checked the same way:
 * it must equal WrapParams.v1() (encryption spec §6.2's version 1).
 *
 * WrapParams exposes no getters, so the comparison is by behaviour: the
 * vector's password and salt, derived under each, must give the vector's
 * proof. Argon2id's output depends on all three parameters, so equal proofs
 * mean equal parameters.
 */
import { readFileSync } from "node:fs";
import { loadEnvelope } from "$lib/envelope";
import { OWNER_KDF_V1, RECIPIENT_KDF_V1 } from "@vitrina/shared";
import { describe, expect, it } from "vitest";

type OwnerWrapVector = { name: string; password: string; salt: string; params: { m_cost_kib: number; t_cost: number; p_cost: number }; proof: string };

const VECTORS = new URL("../../../../../spec/vectors/vitrina-vectors.json", import.meta.url);
const vector = (JSON.parse(readFileSync(VECTORS, "utf8")) as { owner_wrap: OwnerWrapVector[] }).owner_wrap.find((v) => v.name.startsWith("v1 "));

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

describe("OWNER_KDF_V1, RECIPIENT_KDF_V1, the crate's WrapParams.v1() and the spec agree", () => {
  it("the shared constant equals the spec vector's v1 parameters", () => {
    expect(vector, "spec/vectors has an owner_wrap v1 vector").toBeDefined();
    expect(OWNER_KDF_V1).toEqual({ memoryKib: vector?.params.m_cost_kib, iterations: vector?.params.t_cost, parallelism: vector?.params.p_cost });
  });

  it("deriving under each gives the vector's proof", async () => {
    if (vector === undefined) throw new Error("no owner_wrap v1 vector");
    const { envelope: env } = await loadEnvelope();
    const proofUnder = (params: InstanceType<typeof env.WrapParams>): string => {
      try {
        const credential = env.deriveOwnerCredential(vector.password, hex(vector.salt), params);
        const proof = toHex(credential.proof);
        credential.free();
        return proof;
      } finally {
        params.free();
      }
    };
    const fromShared = proofUnder(new env.WrapParams(OWNER_KDF_V1.memoryKib, OWNER_KDF_V1.iterations, OWNER_KDF_V1.parallelism));
    const fromCrate = proofUnder(env.WrapParams.v1());
    const fromRecipient = proofUnder(new env.WrapParams(RECIPIENT_KDF_V1.memoryKib, RECIPIENT_KDF_V1.iterations, RECIPIENT_KDF_V1.parallelism));
    expect(fromShared, "OWNER_KDF_V1").toBe(vector.proof);
    expect(fromCrate, "WrapParams.v1()").toBe(vector.proof);
    expect(fromRecipient, "RECIPIENT_KDF_V1").toBe(fromCrate);
  }, 90_000);
});
