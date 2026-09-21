/*
 * Schema §6's canonical form, in one place — the boundary where base64url
 * becomes bytes. Transport is text; everything inward is bytes (§7.2).
 * Two callers today: the credential routes' bodies and the bearer scheme.
 */

/** Thrown for a non-canonical or wrong-length spelling. Callers map it. */
export class MalformedEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedEncodingError";
  }
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Decode strictly to exactly `expectedBytes`, then RE-ENCODE and require
 * equality. 43 characters carry 258 bits and a token is 256, so four distinct
 * strings decode to the same 32 bytes; "43 chars decoding to 32" identifies no
 * unique spelling. Any standard encoder emits the canonical one.
 */
export function decodeBase64url(value: string, expectedBytes: number): Uint8Array {
  if (!BASE64URL.test(value)) {
    throw new MalformedEncodingError("not base64url, or padded");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== expectedBytes) {
    throw new MalformedEncodingError(`decodes to ${decoded.byteLength} bytes, expected ${expectedBytes}`);
  }
  if (decoded.toString("base64url") !== value) {
    throw new MalformedEncodingError("non-canonical spelling");
  }
  return decoded;
}

/** The canonical spelling. A decoy encoded any other way is a distinguisher. */
export function encodeBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** Characters a base64url string of `bytes` bytes has, unpadded. */
export function encodedLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}
