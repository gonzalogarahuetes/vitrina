/*
 * base64url field → bytes, malformed → `400` — the half base64url.ts leaves to
 * its callers. Anything that is not a MalformedEncodingError is rethrown, so a
 * real fault still reaches the 500 branch and logs a stack.
 */

import {
  decodeBase64url,
  decodeBase64urlRange,
  MalformedEncodingError,
} from "./base64url.js";
import { ApiError } from "./error-envelope.js";

/*
 * NO `details`, and that is §7.3's rule for PR 2's credential routes, where a
 * field name is the §4.3 enumeration hint. It is not a rule about the whole
 * API — §1.1 keeps `details` for routes where a client must know which field.
 */
function or400(decode: () => Uint8Array): Uint8Array {
  try {
    return decode();
  } catch (error) {
    if (error instanceof MalformedEncodingError) {
      throw new ApiError("VALIDATION_FAILED");
    }
    throw error;
  }
}

/*
 * Fixed-length BODY fields: proofs, salts, wrappings, nonces. NOT the bearer
 * token — a malformed one is §7.3 step 1's `401`, indistinguishable from an
 * unknown one, and a `400` here would make the two tell a caller apart.
 */
export function decodeOr400(value: string, bytes: number): Uint8Array {
  return or400(() => decodeBase64url(value, bytes));
}

/** Variable-length fields — §9.6's `metadata` (81–4096 bytes), §9.2's `title` (41–1024). Bounds inclusive. */
export function decodeRangeOr400(
  value: string,
  minBytes: number,
  maxBytes: number,
): Uint8Array {
  return or400(() => decodeBase64urlRange(value, minBytes, maxBytes));
}
