import { describe, expect, it } from "vitest";
import { EnvelopeUnavailable, instantiate, loadEnvelope } from "./envelope";

describe("envelope module loading", () => {
  // First: a failed instantiation leaves the glue uninitialised, so the real
  // load below still has to succeed on its own.
  it("reports a module that will not instantiate as EnvelopeUnavailable", async () => {
    await expect(instantiate(() => new Uint8Array([0, 1, 2, 3]))).rejects.toBeInstanceOf(EnvelopeUnavailable);
  });

  it("loads the real build once and exposes the module", async () => {
    const first = loadEnvelope();
    expect(loadEnvelope()).toBe(first);
    const envelope = await first;
    // A constant, not cryptography: proves the module is instantiated.
    expect(envelope.chunkSize()).toBe(256 * 1024);
  });
});
