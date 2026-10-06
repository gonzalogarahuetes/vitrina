import type { FastifyInstance } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { makeRequireOwner } from "../auth/owner.js";
import { ApiError } from "../error-envelope.js";
import {
  createRecipientSchema,
  revokeRecipientSchema,
} from "../schemas/recipients.js";
import { rfc3339 } from "../rfc3339.js";
import { decodeOr400, decodeRangeOr400 } from "../decode-field.js";
import type { NewRecipient } from "../../../../application/ports/recipient-repository.js";

export type RecipientRoutesDeps = {
  readonly useCases: UseCases;
};

type CreateRecipientBody = {
  id: string;
  kind: "qr" | "passphrase";
  label: string;
  token_hash: string;
  wrapped: string;
  wrap_nonce: string;
  kdf_salt: string;
  kdf_memory_kib: number;
  kdf_iterations: number;
  kdf_parallelism: number;
};

export function recipientRoutes(deps: RecipientRoutesDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireOwner = makeRequireOwner(deps.useCases);

    app.post<{ Body: CreateRecipientBody; Params: { album_id: string } }>(
      "/albums/:album_id/recipients",
      { schema: createRecipientSchema, preHandler: requireOwner },
      async (request, reply) => {
        const caller = request.caller;
        if (caller?.kind !== "owner") throw new ApiError("UNAUTHENTICATED");

        const body = request.body;

        let newRecipient: NewRecipient = {
          id: body.id,
          albumId: request.params.album_id,
          kind: "qr",
          label: decodeRangeOr400(body.label, 41, 1024),
          tokenHash: decodeOr400(body.token_hash, 32),
        };

        if (body.kind === "passphrase") {
          newRecipient = {
            ...newRecipient,
            kind: "passphrase",
            wrap: {
              wrapped: decodeOr400(body.wrapped, 48),
              wrapNonce: decodeOr400(body.wrap_nonce, 24),
              kdfSalt: decodeOr400(body.kdf_salt, 16),
              params: {
                iterations: body.kdf_iterations,
                memoryKib: body.kdf_memory_kib,
                parallelism: body.kdf_parallelism,
              },
            },
          };
        }

        const created = await deps.useCases.createRecipient({
          ownerId: caller.ownerId,
          recipient: newRecipient,
        });

        return reply.code(201).send({
          id: created.id,
          created_at: rfc3339(created.createdAt),
        });
      },
    );

    app.post<{ Params: { recipient_id: string } }>(
      "/recipients/:recipient_id/revoke",
      { schema: revokeRecipientSchema, preHandler: requireOwner },
      async (request, reply) => {
        const caller = request.caller;
        if (caller?.kind !== "owner") throw new ApiError("UNAUTHENTICATED");

        const revokedAt = await deps.useCases.revokeRecipient({
          ownerId: caller.ownerId,
          recipientId: request.params.recipient_id,
        });

        return reply.code(200).send({
          revoked_at: rfc3339(revokedAt),
        });
      },
    );
  };
}
