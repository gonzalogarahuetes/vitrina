/*
 * §9.2's two album routes — api-sketch §9.1, §9.2, §4.1.
 * Each handler decodes the wire into bytes, calls one use case, and encodes
 * the result back. The relay never inspects a wrapping (§9.1).
 */

import type { FastifyInstance } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { makeRequireOwner } from "../auth/owner.js";
import { encodeBase64url } from "../base64url.js";
import { decodeOr400 } from "../decode-field.js";
import { ApiError } from "../error-envelope.js";
import { rfc3339 } from "../rfc3339.js";
import { createAlbumSchema, listAlbumsSchema } from "../schemas/albums.js";

export type AlbumRoutesDeps = {
  readonly useCases: UseCases;
};

type CreateAlbumBody = {
  id: string;
  title: string;
  wrapped_key: string;
  wrap_nonce: string;
};

export function albumRoutes(deps: AlbumRoutesDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireOwner = makeRequireOwner(deps.useCases);

    /*
     * §8.3's rule, as one hook: every response carrying a wrapped blob carries
     * `no-store`. §9.2's list returns every wrapping the owner has, which makes
     * it the third such route after §8.3's and §7.5's.
     */
    app.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });

    /*
     * NO IP LIMITER HERE. §7.6's is for the three routes with no token to key
     * on; authenticated limiting is §11.5's, keyed on the token hash, in PR 5.
     * An IP budget would make two families behind one NAT share a quota.
     */
    app.post<{ Body: CreateAlbumBody }>(
      "/albums",
      { schema: createAlbumSchema, preHandler: requireOwner },
      async (request, reply) => {
        const caller = request.caller;
        if (caller?.kind !== "owner") throw new ApiError("UNAUTHENTICATED");

        const body = request.body;
        /*
         * The two ids have opposite reasons. `id` is the CLIENT's: it sits
         * inside the wrap AAD, so it existed before `wrapped_key` could be
         * computed (§9.1). `ownerId` is the SERVER's, from the token — a
         * body-supplied one creates albums in another parent's account.
         */
        const created = await deps.useCases.createAlbum({
          id: body.id,
          ownerId: caller.ownerId,
          title: body.title,
          wrappedKey: decodeOr400(body.wrapped_key, 48),
          wrapNonce: decodeOr400(body.wrap_nonce, 24),
        });

        // A duplicate id is `409` from the use case (§9.2): "already created",
        // never "try again" — a fresh id orphans the wrapping.
        return reply.code(201).send({
          id: created.id,
          created_at: rfc3339(created.createdAt),
        });
      },
    );

    app.get(
      "/albums",
      { schema: listAlbumsSchema, preHandler: requireOwner },
      async (request, reply) => {
        const caller = request.caller;
        if (caller?.kind !== "owner") throw new ApiError("UNAUTHENTICATED");

        // Owner-only by construction, so there is no branch on caller kind —
        // §9.2's argument for putting the wrappings here and not on §9.4.
        const albums = await deps.useCases.listAlbums({
          ownerId: caller.ownerId,
        });

        return reply.send({
          albums: albums.map((album) => ({
            id: album.id,
            title: album.title,
            created_at: rfc3339(album.createdAt),
            wrapped_key: encodeBase64url(album.wrappedKey),
            wrap_nonce: encodeBase64url(album.wrapNonce),
            media_count: album.mediaCount,
          })),
        });
      },
    );
  };
}
