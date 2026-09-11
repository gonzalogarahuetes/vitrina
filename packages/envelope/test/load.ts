import { readFile } from "node:fs/promises";
import init, * as envelope from "../wasm/envelope.js";

export type Envelope = typeof envelope;
export type { AlbumKey } from "../wasm/envelope.js";

/** packages/envelope/, resolved from the compiled location dist/test/. */
export const PACKAGE_ROOT = new URL("../../", import.meta.url);
export const REPO_ROOT = new URL("../../", PACKAGE_ROOT);

let loaded: Promise<Envelope> | undefined;

// Node cannot fetch() a file: URL, so the bytes are read and handed to init.
export function loadEnvelope(): Promise<Envelope> {
  loaded ??= (async () => {
    const bytes = await readFile(new URL("../wasm/envelope_bg.wasm", import.meta.url));
    await init({ module_or_path: bytes });
    return envelope;
  })();
  return loaded;
}

export const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
export const unhex = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "hex"));

/** The fields every binding error carries; `instanceof Error` holds as well. */
export interface EnvelopeErrorShape {
  name: string;
  code: string;
  message: string;
  param?: string;
  reason?: string;
  expected?: number;
  got?: number;
}

export function isEnvelopeError(e: unknown): e is Error & EnvelopeErrorShape {
  return e instanceof Error && e.name === "EnvelopeError" && typeof (e as { code?: unknown }).code === "string";
}

/** Runs `f`, asserting it throws a binding error, and returns that error. */
export function caught(f: () => unknown): Error & EnvelopeErrorShape {
  try {
    f();
  } catch (e) {
    if (isEnvelopeError(e)) return e;
    throw new Error(`threw something other than an EnvelopeError: ${String(e)}`);
  }
  throw new Error("did not throw");
}
