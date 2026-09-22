/*
 * Schema §6's canonical form, in one place — the boundary where base64url
 * becomes bytes. Transport is text; everything inward is bytes (§7.2).
 * Mapping a malformed field to a status is deliberately NOT here — see
 * decode-field.ts, which owns that half.
 */

/** Thrown for a non-canonical or wrong-length spelling. Callers map it. */
export class MalformedEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedEncodingError";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Alphabet check and decode. The length check is each caller's next step. */
function decodeRaw(value: string): Buffer {
  if (!BASE64URL.test(value)) {
    throw new MalformedEncodingError("not base64url, or padded");
  }
  return Buffer.from(value, "base64url");
}

/** One copy of the re-encode rule, so the two length forms cannot drift. */
function requireCanonical(decoded: Buffer, value: string): Uint8Array {
  if (decoded.toString("base64url") !== value) {
    throw new MalformedEncodingError("non-canonical spelling");
  }
  return decoded;
}

/**
 * Decode strictly to exactly `expectedBytes`, then RE-ENCODE and require
 * equality. 43 characters carry 258 bits and a token is 256, so four distinct
 * strings decode to the same 32 bytes; "43 chars decoding to 32" identifies no
 * unique spelling. Any standard encoder emits the canonical one.
 */
export function decodeBase64url(value: string, expectedBytes: number): Uint8Array {
  const decoded = decodeRaw(value);
  if (decoded.byteLength !== expectedBytes) {
    throw new MalformedEncodingError(`decodes to ${decoded.byteLength} bytes, expected ${expectedBytes}`);
  }
  return requireCanonical(decoded, value);
}

/**
 * The same rule with a bounded length, for §9.6's `metadata` — the first
 * variable-length binary field in the system. Bounds are inclusive and are a
 * body cap, not a format claim (§9.6).
 */
export function decodeBase64urlRange(
  value: string,
  minBytes: number,
  maxBytes: number,
): Uint8Array {
  const decoded = decodeRaw(value);
  if (decoded.byteLength < minBytes || decoded.byteLength > maxBytes) {
    throw new MalformedEncodingError(
      `decodes to ${decoded.byteLength} bytes, expected ${minBytes}-${maxBytes}`,
    );
  }
  return requireCanonical(decoded, value);
}

/** The canonical spelling. A decoy encoded any other way is a distinguisher. */
export function encodeBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Characters a base64url string of `bytes` bytes has, unpadded. */
export function encodedLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}
