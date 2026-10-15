/*
 * Schema §6's canonical form lives in @vitrina/shared, so the server and the
 * web client decode with one implementation. This file keeps every importer's
 * path, and test/base64url.test.mjs's, unchanged.
 *
 * The decoders are wrapped only to hand back a `Buffer` view over the same
 * bytes (no copy): that is what this module returned before the move, and
 * server code and tests compare against Buffers. The rule itself is shared.
 * Mapping a malformed field to a status stays in decode-field.ts.
 */
import {
  decodeBase64url as decodeShared,
  decodeBase64urlRange as decodeRangeShared,
} from "@vitrina/shared";

export { encodeBase64url, encodedLength, MalformedEncodingError } from "@vitrina/shared";

const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function decodeBase64url(value: string, expectedBytes: number): Buffer {
  return asBuffer(decodeShared(value, expectedBytes));
}

export function decodeBase64urlRange(value: string, minBytes: number, maxBytes: number): Buffer {
  return asBuffer(decodeRangeShared(value, minBytes, maxBytes));
}
