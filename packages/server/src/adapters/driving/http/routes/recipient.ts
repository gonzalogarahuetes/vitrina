/*
 * The recipient scheme's routes about the caller's own row — api-sketch §10.1
 * now, §11.4's GET /v1/recipient in PR 5. Flat paths, no ids: the bearer
 * token resolves to exactly one `recipients` row, and that is the scope check.
 *
 * Separate from recipients.ts, which is the OWNER's create and revoke and
 * must not carry `no-store` (recipient-routes.test.mjs asserts it does not).
 */

import type { FastifyInstance } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import {
  retrieveRecipientKeySchema,
  retrieveRecipientSchema,
} from "../schemas/recipients.js";
import { ApiError } from "../error-envelope.js";
import { makeRequireRecipient } from "../auth/recipient.js";
import { encodeBase64url } from "../base64url.js";
import { rfc3339 } from "../rfc3339.js";

export type RecipientRoutesDeps = {
  readonly useCases: UseCases;
};

export function ownRecipientRoutes(deps: RecipientRoutesDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    /*
     * One hook rather than handlers remembering. §10.1 carries a wrapped blob
     * (§8.3's rule); §11.4 carries `label`, which is ciphertext (§11.3's rule).
     * Both get `no-store`, so the hook covers the plugin.
     */
    app.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });

    app.get(
      "/recipient/key",
      {
        schema: retrieveRecipientKeySchema,
        // Recipient scheme ONLY — never the either-scheme preHandler (§7.1).
        preHandler: makeRequireRecipient(deps.useCases),
      },
      async (request, reply) => {
        const caller = request.caller;
        if (caller?.kind !== "recipient") throw new ApiError("UNAUTHENTICATED");

        const { recipientId, wrap } = await deps.useCases.getRecipientKey({
          grant: caller.grant,
        });

        return reply.code(200).send({
          id: recipientId,
          kdf_salt: encodeBase64url(wrap.kdfSalt),
          kdf_memory_kib: wrap.params.memoryKib,
          kdf_iterations: wrap.params.iterations,
          kdf_parallelism: wrap.params.parallelism,
          wrapped: encodeBase64url(wrap.wrapped),
          wrap_nonce: encodeBase64url(wrap.wrapNonce),
        });
      },
    );

    app.get(
      "/recipient",
      {
        schema: retrieveRecipientSchema,
        // Recipient scheme ONLY — never the either-scheme preHandler (§7.1).
        preHandler: makeRequireRecipient(deps.useCases),
      },
      async (request, reply) => {
        const caller = request.caller;
        if (caller?.kind !== "recipient") throw new ApiError("UNAUTHENTICATED");

        const recipientDetails = await deps.useCases.getOwnRecipient({
          grant: caller.grant,
        });

        return reply.code(200).send({
          id: recipientDetails.id,
          label: encodeBase64url(recipientDetails.label),
          kind: recipientDetails.kind,
          album_id: recipientDetails.albumId,
          created_at: rfc3339(recipientDetails.createdAt),
        });
      },
    );
  };
}
