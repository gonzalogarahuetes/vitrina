import { describe, expect, it } from "vitest";
import { EnvelopeUnavailable, guard, instantiate, loadEnvelope } from "./envelope";

describe("envelope module loading", () => {
  // First: a failed instantiation leaves the glue uninitialised, so the real
  // load below still has to succeed on its own.
  it("reports a module that will not instantiate as EnvelopeUnavailable", async () => {
    await expect(instantiate(() => new Uint8Array([0, 1, 2, 3]))).rejects.toBeInstanceOf(EnvelopeUnavailable);
  });

  it("loads the real build once and exposes the module", async () => {
    const first = loadEnvelope();
    expect(loadEnvelope()).toBe(first);
    const { envelope } = await first;
    // A constant, not cryptography: proves the module is instantiated.
    expect(envelope.chunkSize()).toBe(256 * 1024);
  });
});

describe("poisoned after a trap", () => {
  class Handle {
    __wbg_ptr = 1;
    frees = 0;
    free(): void {
      this.frees++;
    }
  }
  function fakeModule(trap: () => never) {
    const calls = { ok: 0, trap: 0 };
    const module = {
      Handle,
      ok: () => {
        calls.ok++;
        return new Handle();
      },
      bad: () => {
        calls.trap++;
        trap();
      },
      typed: () => {
        throw Object.assign(new Error("authentication failed"), { name: "EnvelopeError", code: "AuthenticationFailed" });
      },
    };
    return { module, calls };
  }

  for (const [name, trap] of [
    ["RuntimeError", () => { throw new WebAssembly.RuntimeError("unreachable"); }],
    ["RangeError", () => { throw new RangeError("Out of memory"); }],
  ] as const) {
    it(`a ${name} poisons the module and nothing touches the instance afterwards`, () => {
      const { module, calls } = fakeModule(trap);
      const { envelope, poison } = guard(module);
      const handle = envelope.ok();
      let notified = 0;
      poison.onPoison(() => notified++);

      expect(() => envelope.bad()).toThrow(EnvelopeUnavailable);
      expect(poison.poisoned).toBe(true);
      expect(notified).toBe(1);

      expect(() => envelope.ok()).toThrow(EnvelopeUnavailable);
      expect(() => handle.free()).toThrow(EnvelopeUnavailable);
      expect(() => envelope.bad()).toThrow(EnvelopeUnavailable);
      expect(calls).toEqual({ ok: 1, trap: 1 });
      expect(notified).toBe(1);
    });
  }

  it("an EnvelopeError is a result, not a trap: it passes through and poisons nothing", () => {
    const { module } = fakeModule(() => { throw new Error("unused"); });
    const { envelope, poison } = guard(module);
    expect(() => envelope.typed()).toThrow(/authentication failed/);
    expect(poison.poisoned).toBe(false);
    expect(envelope.ok()).toBeDefined();
  });

  it("hands wasm-bindgen the raw handle, so instanceof and free() see what it registered", () => {
    const { module } = fakeModule(() => { throw new Error("unused"); });
    let seen: unknown;
    const withArg = { ...module, take: (h: unknown) => { seen = h; } };
    const { envelope } = guard(withArg);
    const handle = envelope.ok();
    envelope.take(handle);
    expect(seen).toBeInstanceOf(Handle);
    expect(seen).not.toBe(handle);
    handle.free();
    expect((seen as Handle).frees).toBe(1);
  });
});
