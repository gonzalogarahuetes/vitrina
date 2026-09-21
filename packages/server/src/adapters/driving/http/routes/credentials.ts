/*
 * The owner credential routes — api-sketch §7.5, §8.3.
 * Each handler does three things and no more: decode the wire into bytes,
 * call one use case, encode the result back. Normalisation, the decoy, the
 * comparison and the transaction all live inward of here.
 */

import type { FastifyInstance } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { makeRequireOwner } from "../auth/owner.js";
import { decodeBase64url, encodeBase64url, MalformedEncodingError } from "../base64url.js";
import { ApiError } from "../error-envelope.js";
import { makeIpRateLimit } from "../rate-limit.js";
import {
  loginParamsSchema,
  loginSchema,
  ownerKeySchema,
  signupSchema,
} from "../schemas/credentials.js";

export type CredentialRoutesDeps = {
  readonly useCases: UseCases;
};

type SignupBody = {
  email: string;
  proof: string;
  kdf_salt: string;
  kdf_memory_kib: number;
  kdf_iterations: number;
  kdf_parallelism: number;
  wrapped_master: string;
  wrap_nonce: string;
};

/**
 * RFC 3339, UTC, trailing Z — §7.5. Not "ISO 8601", which admits week dates,
 * ordinal dates and offset-less local times; a format described loosely is one
 * two implementations can disagree about.
 */
const rfc3339 = (at: Date): string => at.toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * A malformed encoded field is `400`, with no `details` — §7.3: every code in
 * this PR is actionable from the code alone, and on a credential route a field
 * name is where a distinguishing hint leaks.
 */
function decodeOr400(value: string, bytes: number): Uint8Array {
  try {
    return decodeBase64url(value, bytes);
  } catch (error) {
    if (error instanceof MalformedEncodingError) throw new ApiError("VALIDATION_FAILED");
    throw error;
  }
}

export function credentialRoutes(deps: CredentialRoutesDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireOwner = makeRequireOwner(deps.useCases);
    // One limiter instance, so the three routes share a budget per address.
    const ipRateLimit = makeIpRateLimit();

    /*
     * One hook rather than four handlers remembering — §7.5 states the rule as
     * blanket for exactly this reason. It covers /owner/key too, on §8.3's
     * "every response carrying a wrapped blob carries no-store".
     */
    app.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });

    app.post<{ Body: SignupBody }>(
      "/signup",
      { schema: signupSchema, preHandler: ipRateLimit },
      async (request, reply) => {
        const body = request.body;
        const created = await deps.useCases.signup({
          email: body.email,
          proof: decodeOr400(body.proof, 32),
          kdfSalt: decodeOr400(body.kdf_salt, 16),
          params: {
            memoryKib: body.kdf_memory_kib,
            iterations: body.kdf_iterations,
            parallelism: body.kdf_parallelism,
          },
          wrappedMaster: decodeOr400(body.wrapped_master, 48),
          wrapNonce: decodeOr400(body.wrap_nonce, 24),
        });

        // The token is minted here, by /login's code path (§7.4): a client that
        // has just derived a proof should not hold it across a round trip to
        // trade it for a session. The wrapping does not come back — §8.3 does
        // that, after login, on any device.
        return reply.code(201).send({
          id: created.id,
          created_at: rfc3339(created.createdAt),
          token: encodeBase64url(created.token),
          expires_at: rfc3339(created.expiresAt),
        });
      },
    );

    app.post<{ Body: { email: string } }>(
      "/login/params",
      { schema: loginParamsSchema, preHandler: ipRateLimit },
      async (request, reply) => {
        // Always 200, for an unknown address as much as a known one (§4.3).
        const row = await deps.useCases.loginParams({ email: request.body.email });
        return reply.send({
          kdf_salt: encodeBase64url(row.kdfSalt),
          kdf_memory_kib: row.params.memoryKib,
          kdf_iterations: row.params.iterations,
          kdf_parallelism: row.params.parallelism,
        });
      },
    );

    app.post<{ Body: { email: string; proof: string } }>(
      "/login",
      { schema: loginSchema, preHandler: ipRateLimit },
      async (request, reply) => {
        // Malformed → 400 BEFORE any lookup: a string that is not a well-formed
        // proof cannot be one, and rejecting it says nothing about the address.
        const proof = decodeOr400(request.body.proof, 32);
        const session = await deps.useCases.login({ email: request.body.email, proof });
        return reply.send({
          token: encodeBase64url(session.token),
          expires_at: rfc3339(session.expiresAt),
        });
      },
    );

    app.get(
      "/owner/key",
      { schema: ownerKeySchema, preHandler: requireOwner },
      async (request, reply) => {
        // Set by requireOwner; the route reads no id from the request (§8.3).
        const ownerId = request.ownerId;
        if (ownerId === undefined) throw new ApiError("UNAUTHENTICATED");

        const key = await deps.useCases.ownerKey({ ownerId });
        return reply.send({
          kdf_salt: encodeBase64url(key.kdfSalt),
          kdf_memory_kib: key.params.memoryKib,
          kdf_iterations: key.params.iterations,
          kdf_parallelism: key.params.parallelism,
          wrapped_master: encodeBase64url(key.wrappedMaster),
          wrap_nonce: encodeBase64url(key.wrapNonce),
        });
      },
    );
  };
}
