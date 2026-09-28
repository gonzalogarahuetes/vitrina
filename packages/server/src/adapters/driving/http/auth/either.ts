/*
 * The dual scheme — api-sketch §7.1, §7.3 step 1, for §9.4 and §9.5.
 * The two lookups are PEERS, not a fallback: §7.1 forbids a route declaring
 * ONE scheme from consulting the other table, and these declare both.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { decodeBase64url, encodedLength, MalformedEncodingError } from "../base64url.js";
import { ApiError } from "../error-envelope.js";

const TOKEN_BYTES = 32;
const TOKEN_CHARS = encodedLength(TOKEN_BYTES); // 43

/** Both credentials are 32 bytes in the same header; only the table differs. */
export function makeRequireOwnerOrRecipient(useCases: UseCases) {
  return async function requireOwnerOrRecipient(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    reply.header("WWW-Authenticate", "Bearer");

    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new ApiError("UNAUTHENTICATED");
    }

    const presented = header.slice("Bearer ".length);
    if (presented.length !== TOKEN_CHARS) throw new ApiError("UNAUTHENTICATED");

    let token: Uint8Array;
    try {
      token = decodeBase64url(presented, TOKEN_BYTES);
    } catch (error) {
      // Only a malformed spelling is a 401; anything else is a fault.
      if (error instanceof MalformedEncodingError) throw new ApiError("UNAUTHENTICATED");
      throw error;
    }

    const [ownerId, grant] = await Promise.all([
      useCases.authenticateOwner({ token }),
      useCases.authenticateRecipient({ token }),
    ]);

    if (ownerId !== null && grant !== null) {
      // A 32-byte collision across the two tables will not happen; resolving
      // to either kind would be a caller acting with the wrong scope.
      throw new Error("one token matched both an owner and a recipient");
    }

    if (ownerId !== null) {
      request.caller = { kind: "owner", ownerId };
      return;
    }
    if (grant !== null) {
      // The grant keeps `revokedAt` — step 4 is the use case's, after step 3.
      request.caller = { kind: "recipient", grant };
      return;
    }

    throw new ApiError("UNAUTHENTICATED");
  };
}
