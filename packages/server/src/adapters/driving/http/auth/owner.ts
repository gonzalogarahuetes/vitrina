/*
 * The owner bearer scheme — api-sketch §7.2, §7.3 steps 1 and 2.
 * This half is transport: read the header, decode strictly, and turn "no
 * owner" into a status. The lookup and the expiry and revocation checks are
 * the authenticateOwner use case's, so no repository reaches buildServer.
 */

import type { FastifyReply, FastifyRequest } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { decodeBase64url, encodedLength } from "../base64url.js";
import { ApiError } from "../error-envelope.js";

const TOKEN_BYTES = 32;
const TOKEN_CHARS = encodedLength(TOKEN_BYTES); // 43

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the preHandler below; present only on owner-scheme routes. */
    ownerId?: string;
  }
}

/**
 * Every failure is `401 UNAUTHENTICATED` with no `details`: absent, malformed,
 * unknown, expired and revoked are one answer. A revoked OWNER token is 401
 * and not 403 because an owner logs in again and a revoked recipient cannot
 * (§7.3) — the codes differ so the client renders the right sentence.
 */
export function makeRequireOwner(useCases: UseCases) {
  return async function requireOwner(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // No realm — it would name the deployment — and no error_description,
    // which is where RFC 6750 invites the echo #15 forbids.
    reply.header("WWW-Authenticate", "Bearer");

    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      throw new ApiError("UNAUTHENTICATED");
    }

    const presented = header.slice("Bearer ".length);
    if (presented.length !== TOKEN_CHARS) throw new ApiError("UNAUTHENTICATED");

    let ownerId: string | null;
    try {
      // A value that is not a well-formed token cannot be one, so it is
      // rejected at the boundary rather than hashed and looked up (§7.2).
      ownerId = await useCases.authenticateOwner({
        token: decodeBase64url(presented, TOKEN_BYTES),
      });
    } catch {
      throw new ApiError("UNAUTHENTICATED");
    }

    if (ownerId === null) throw new ApiError("UNAUTHENTICATED");
    request.ownerId = ownerId;
  };
}
