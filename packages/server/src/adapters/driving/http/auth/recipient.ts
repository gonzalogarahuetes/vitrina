/*
 * The recipient bearer scheme — api-sketch §7.2, §7.3 step 1 ONLY.
 * There is no step 2 here: recipient tokens carry no expiry, only revocation
 * (§7.1). Revocation is step 4 and the route's, after it has resolved scope.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import {
  decodeBase64url,
  encodedLength,
  MalformedEncodingError,
} from "../base64url.js";
import { ApiError } from "../error-envelope.js";
import type { AuthenticatedRecipient } from "../../../../application/use-cases/authenticate-recipient.js";

const TOKEN_BYTES = 32;
const TOKEN_CHARS = encodedLength(TOKEN_BYTES); // 43

/**
 * Absent, malformed and unknown are one answer — `401`, no `details`. A
 * REVOKED grant is not a failure here: it is set on the request with its
 * `revokedAt` intact, so the route can answer `403` for the caller's own album
 * and `404` for any other (§7.3, steps 3 then 4).
 */
export function makeRequireRecipient(useCases: UseCases) {
  return async function requireRecipient(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    // No realm — it would name the deployment — and no error_description,
    // which is where RFC 6750 invites the echo #15 forbids.
    reply.header("WWW-Authenticate", "Bearer");

    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new ApiError("UNAUTHENTICATED");
    }

    const presented = header.slice("Bearer ".length);
    if (presented.length !== TOKEN_CHARS) throw new ApiError("UNAUTHENTICATED");

    let authenticatedRecipient: AuthenticatedRecipient | null;
    try {
      // A value that is not a well-formed token cannot be one, so it is
      // rejected at the boundary rather than hashed and looked up (§7.2).
      authenticatedRecipient = await useCases.authenticateRecipient({
        token: decodeBase64url(presented, TOKEN_BYTES),
      });
    } catch (error) {
      if (error instanceof MalformedEncodingError) {
        throw new ApiError("UNAUTHENTICATED");
      }
      throw error;
    }

    if (authenticatedRecipient === null) throw new ApiError("UNAUTHENTICATED");
    // §11.5: after step 1, and before revocation — a revoked grant still pays.
    request.server.tokenLimiter.admit(request, reply, authenticatedRecipient.tokenHash);
    request.caller = {
      kind: "recipient",
      grant: authenticatedRecipient.grant,
    };
  };
}
