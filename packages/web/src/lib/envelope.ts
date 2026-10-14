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

export async function instantiate(bytes: () => BufferSource): Promise<Envelope> {
  try {
    await init({ module_or_path: bytes() });
    return envelope;
  } catch (cause) {
    throw new EnvelopeUnavailable("envelope module failed to load", { cause });
  }
}

let loading: Promise<Envelope> | undefined;

/** The one load. A failure is remembered: it is a state, not something to retry behind a screen's back. */
export function loadEnvelope(): Promise<Envelope> {
  loading ??= instantiate(() => decodeBase64(wasmBase64));
  return loading;
}
