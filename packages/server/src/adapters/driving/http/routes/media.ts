/*
 * §9.6's media create — api-sketch §9.1, §9.3, §9.6.
 * The handler decodes the wire into bytes, calls one use case, and encodes the
 * result back. §9.7's uploads and §9.8's status join it here.
 *
 * NO `no-store` HOOK. Nothing this plugin returns carries a wrapping or
 * ciphertext — §9.6's `201` and §9.8's status object are identifiers and a
 * state. Copying §8.3's header here would make a decision look like a default,
 * which §11.3 argues against; a route that needs it adds it and says why.
 */

import type { FastifyInstance } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { makeRequireOwner } from "../auth/owner.js";
import { decodeRangeOr400 } from "../decode-field.js";
import { ApiError } from "../error-envelope.js";
import { rfc3339 } from "../rfc3339.js";
import { createMediaSchema, getMediaSchema } from "../schemas/media.js";
import type { MediaRow } from "../../../../application/ports/media-repository.js";

export type MediaRoutesDeps = {
  readonly useCases: UseCases;
};

type CreateMediaBody = {
  id: string;
  kind: "photo";
  metadata: string;
};

/**
 * §9.8's seven fields, and the shape §9.7's uploads return too — "one type for
 * where this row is, whether the client asked or was told". Mapped field by
 * field, not spread: `MediaRow` carries `ownerId` from §9.3's join.
 */
const statusBody = (row: MediaRow) => ({
  id: row.id,
  album_id: row.albumId,
  kind: row.kind,
  status: row.status,
  byte_size: row.byteSize,
  created_at: rfc3339(row.createdAt),
  updated_at: rfc3339(row.updatedAt),
});

export function mediaRoutes(deps: MediaRoutesDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireOwner = makeRequireOwner(deps.useCases);

    /*
     * NO IP LIMITER HERE. §7.6's is for the three routes with no token to key
     * on; authenticated limiting is §11.5's, keyed on the token hash, in PR 5.
     * An IP budget would make two families behind one NAT share a quota.
     */
    app.post<{ Body: CreateMediaBody; Params: { album_id: string } }>(
      "/albums/:album_id/media",
      { schema: createMediaSchema, preHandler: requireOwner },
      async (request, reply) => {
        const caller = request.caller;
        if (caller?.kind !== "owner") throw new ApiError("UNAUTHENTICATED");

        const body = request.body;
        /*
         * Three ids, three sources. `id` is the CLIENT's — it IS the
         * envelope's `asset_id`, fixed before encryption began (§9.6).
         * `album_id` is the PATH's, and §9.3 resolves it against the caller.
         * `ownerId` is the TOKEN's; a body-supplied one writes into another
         * parent's album.
         */
        const created = await deps.useCases.createMedia({
          id: body.id,
          albumId: request.params.album_id,
          ownerId: caller.ownerId,
          kind: body.kind,
          metadata: decodeRangeOr400(body.metadata, 81, 4096),
        });

        // §9.6: a duplicate id is `409`, meaning "already created" and never
        // "try again" — a fresh id orphans the envelope just encrypted. And
        // `status` is the column the row was created with, not a literal.
        return reply.code(201).send({
          id: created.id,
          created_at: rfc3339(created.createdAt),
          status: created.status,
        });
      },
    );

    app.get<{ Params: { media_id: string } }>(
      "/media/:media_id",
      { schema: getMediaSchema, preHandler: requireOwner },
      async (request, reply) => {
        const caller = request.caller;
        if (caller?.kind !== "owner") throw new ApiError("UNAUTHENTICATED");

        /*
         * No 404 branch here: the use case throws MEDIA_NOT_FOUND and the
         * envelope maps it, so absent and out-of-scope stay one answer and
         * this route cannot hand-roll a second error shape (§1.1).
         *
         * Owner-only, deliberately — a recipient learns status from §9.4, per
         * album, and there is no recipient case for polling one row (§9.8).
         */
        const row = await deps.useCases.findMediaById({
          mediaId: request.params.media_id,
          ownerId: caller.ownerId,
        });

        return reply.code(200).send(statusBody(row));
      },
    );
  };
}
