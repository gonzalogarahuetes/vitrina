/*
 * Schema §6's canonical form, in one place — the boundary where base64url
 * becomes bytes. Transport is text; everything inward is bytes (api-sketch §7.2).
 * Mapping a malformed field to a status or a screen is deliberately NOT here:
 * the server's decode-field.ts and the web client's callers own that half.
 *
 * Portable: Uint8Array and strings only. No `Buffer` (Node only) and no
 * `Uint8Array.fromBase64` (not in every browser this app supports), so the
 * server and the browser run the same code and cannot disagree on a spelling.
 */

/** Thrown for a non-canonical or wrong-length spelling. Callers map it. */
export class MalformedEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedEncodingError";
  }
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Unpadded, URL alphabet only. `+`, `/` and `=` are refused here. */
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const DECODE: ReadonlyMap<string, number> = new Map([...ALPHABET].map((c, i) => [c, i]));

function sextet(value: string, i: number): number {
  // The regex has already admitted only alphabet characters.
  return DECODE.get(value.charAt(i)) ?? 0;
}

/**
 * Alphabet check and decode. The length check is each caller's next step.
 * Spare low bits in the last character are dropped here and caught by
 * `requireCanonical`; a length ≡ 1 (mod 4) cannot be a whole byte and its
 * last character is dropped the same way, then caught the same way.
 */
function decodeRaw(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(value)) {
    throw new MalformedEncodingError("not base64url, or padded");
  }
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let o = 0;
  let i = 0;
  for (; i + 4 <= value.length; i += 4) {
    const n = (sextet(value, i) << 18) | (sextet(value, i + 1) << 12) | (sextet(value, i + 2) << 6) | sextet(value, i + 3);
    out[o++] = (n >>> 16) & 0xff;
    out[o++] = (n >>> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  const rest = value.length - i;
  if (rest >= 2) {
    const n = (sextet(value, i) << 18) | (sextet(value, i + 1) << 12) | (rest === 3 ? sextet(value, i + 2) << 6 : 0);
    out[o++] = (n >>> 16) & 0xff;
    if (rest === 3) out[o++] = (n >>> 8) & 0xff;
  }
  return out.subarray(0, o);
}

/** One copy of the re-encode rule, so the two length forms cannot drift. */
function requireCanonical(decoded: Uint8Array<ArrayBuffer>, value: string): Uint8Array<ArrayBuffer> {
  if (encodeBase64url(decoded) !== value) {
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
export function decodeBase64url(value: string, expectedBytes: number): Uint8Array<ArrayBuffer> {
  const decoded = decodeRaw(value);
  if (decoded.byteLength !== expectedBytes) {
    throw new MalformedEncodingError(`decodes to ${decoded.byteLength} bytes, expected ${expectedBytes}`);
  }
  return requireCanonical(decoded, value);
}

/**
 * The same rule with a bounded length, for api-sketch §9.6's `metadata` — the
 * first variable-length binary field in the system. Bounds are inclusive and
 * are a body cap, not a format claim (§9.6).
 */
export function decodeBase64urlRange(value: string, minBytes: number, maxBytes: number): Uint8Array<ArrayBuffer> {
  const decoded = decodeRaw(value);
  if (decoded.byteLength < minBytes || decoded.byteLength > maxBytes) {
    throw new MalformedEncodingError(`decodes to ${decoded.byteLength} bytes, expected ${minBytes}-${maxBytes}`);
  }
  return requireCanonical(decoded, value);
}

/** The canonical spelling: unpadded, spare bits zero. A decoy encoded any other way is a distinguisher. */
export function encodeBase64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += ALPHABET.charAt((n >>> 18) & 63) + ALPHABET.charAt((n >>> 12) & 63) + ALPHABET.charAt((n >>> 6) & 63) + ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += ALPHABET.charAt((n >>> 18) & 63) + ALPHABET.charAt((n >>> 12) & 63);
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += ALPHABET.charAt((n >>> 18) & 63) + ALPHABET.charAt((n >>> 12) & 63) + ALPHABET.charAt((n >>> 6) & 63);
  }
  return out;
}

/** Characters a base64url string of `bytes` bytes has, unpadded. */
export function encodedLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}
