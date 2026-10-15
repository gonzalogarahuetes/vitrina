/*
 * Loads @vitrina/envelope's WASM build, once. This module loads it and nothing
 * more: no call here derives, wraps or unwraps a key.
 *
 * The module bytes are inlined into the JS bundle rather than fetched, so CSP
 * `connect-src` can name the API origin alone. Instantiation is asynchronous
 * (`WebAssembly.instantiate`), which browsers allow for a module this size on
 * the main thread where a synchronous compile is refused.
 */
import init from "@vitrina/envelope/wasm/envelope.js";
import * as envelope from "@vitrina/envelope/wasm/envelope.js";
import wasmBase64 from "virtual:envelope-wasm";

export type Envelope = typeof envelope;

/*
 * The module could not be loaded or instantiated: flows §2's "could not
 * derive" family (an allocation or WASM failure, brief §11). A screen must
 * never present this as a wrong password or passphrase.
 */
export class EnvelopeUnavailable extends Error {
  override readonly name = "EnvelopeUnavailable";
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/*
 * A WASM trap is terminal for the tab. After `RuntimeError` (Rust's abort on a
 * failed allocation surfaces as `unreachable`) or a `RangeError` from
 * allocation, the instance's memory and wasm-bindgen's tables are in an unknown
 * state. From then on every call through the guarded module throws
 * EnvelopeUnavailable WITHOUT touching the instance: no retry, no free(). The
 * only way back is a fresh page load, which re-opening the invitation link is.
 */
export function isTrap(e: unknown): boolean {
  return e instanceof WebAssembly.RuntimeError || e instanceof RangeError;
}

export type Poison = {
  readonly poisoned: boolean;
  /** Called once, on the first trap. */
  onPoison(listener: () => void): () => void;
};

type Handle = object & { readonly __wbg_ptr?: unknown };

/**
 * Wraps the module so every function, constructor, static method, handle
 * method and handle getter is checked against the poisoned flag first, and a
 * trap during any of them poisons it. Handles cross back to wasm-bindgen as
 * their raw objects, so its `instanceof` checks and FinalizationRegistry
 * unregistration see the object it registered, never the proxy.
 */
export function guard<T extends object>(module: T): { envelope: T; poison: Poison } {
  let poisoned = false;
  const listeners = new Set<() => void>();
  const raw = new WeakMap<object, object>();

  const unwrap = (v: unknown): unknown => (typeof v === "object" || typeof v === "function") && v !== null ? (raw.get(v) ?? v) : v;

  function run<R>(fn: () => R): R {
    if (poisoned) throw new EnvelopeUnavailable("envelope module is unusable after a trap");
    try {
      return wrap(fn()) as R;
    } catch (e) {
      if (isTrap(e)) {
        poisoned = true;
        for (const l of listeners) l();
        listeners.clear();
        throw new EnvelopeUnavailable("envelope module trapped", { cause: e });
      }
      throw e;
    }
  }

  function wrap(v: unknown): unknown {
    if (typeof v === "function") return wrapFunction(v as (...a: unknown[]) => unknown);
    if (typeof v === "object" && v !== null && "__wbg_ptr" in v) return wrapHandle(v as Handle);
    return v;
  }

  function wrapFunction(fn: (...a: unknown[]) => unknown): unknown {
    const p = new Proxy(fn, {
      apply: (t, thisArg, args) => run(() => Reflect.apply(t, unwrap(thisArg), args.map(unwrap))),
      construct: (t, args) => run(() => Reflect.construct(t, args.map(unwrap))),
      // Static members: AlbumKey.fromBytes, WrapParams.v1, WrappedKey.fromParts.
      get: (t, prop) => (prop === "prototype" ? Reflect.get(t, prop) : wrap(Reflect.get(t, prop))),
    });
    raw.set(p, fn);
    return p;
  }

  function wrapHandle(h: Handle): unknown {
    const p = new Proxy(h, {
      // Getters call into wasm, so they go through run() like methods do.
      get: (t, prop) => run(() => Reflect.get(t, prop, t)),
    });
    raw.set(p, h);
    return p;
  }

  const envelope = new Proxy(module, {
    get: (t, prop) => wrap(Reflect.get(t, prop)),
  });

  const poison: Poison = {
    get poisoned() {
      return poisoned;
    },
    onPoison(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { envelope, poison };
}

export type LoadedEnvelope = { readonly envelope: Envelope; readonly poison: Poison };

export async function instantiate(bytes: () => BufferSource): Promise<LoadedEnvelope> {
  try {
    await init({ module_or_path: bytes() });
  } catch (cause) {
    throw new EnvelopeUnavailable("envelope module failed to load", { cause });
  }
  return guard(envelope);
}

let loading: Promise<LoadedEnvelope> | undefined;

/** The one load. A failure is remembered: it is a state, not something to retry behind a screen's back. */
export function loadEnvelope(): Promise<LoadedEnvelope> {
  loading ??= instantiate(() => decodeBase64(wasmBase64));
  return loading;
}
