/*
 * The album routes — api-sketch §9.2's create and list, §9.4's details,
 * §9.5's metadata. Each handler decodes the wire, calls one use case, and
 * encodes the result back. The relay never inspects a wrapping (§9.1).
 */

import type { FastifyInstance } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { makeRequireOwner } from "../auth/owner.js";
import { makeRequireOwnerOrRecipient } from "../auth/either.js";
import { encodeBase64url } from "../base64url.js";
import { decodeOr400, decodeRangeOr400 } from "../decode-field.js";
import { ApiError } from "../error-envelope.js";
import { rfc3339 } from "../rfc3339.js";
import {
  createAlbumSchema,
  findAlbumByIdSchema,
  getAlbumMetadataSchema,
  listAlbumsSchema,
} from "../schemas/albums.js";

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
          title: decodeRangeOr400(body.title, 41, 1024),
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
            title: encodeBase64url(album.title),
            created_at: rfc3339(album.createdAt),
            wrapped_key: encodeBase64url(album.wrappedKey),
            wrap_nonce: encodeBase64url(album.wrapNonce),
            media_count: album.mediaCount,
          })),
        });
      },
    );

    /*
     * §9.4 and §9.5 declare BOTH schemes — the only routes that do, and where
     * `ACCESS_REVOKED` first becomes reachable (§9.3).
     */
    const requireCaller = makeRequireOwnerOrRecipient(deps.useCases);

    app.get<{ Params: { album_id: string } }>(
      "/albums/:album_id",
      { schema: findAlbumByIdSchema, preHandler: requireCaller },
      async (request, reply) => {
        const principal = request.caller;
        if (principal === undefined) throw new ApiError("UNAUTHENTICATED");

        const details = await deps.useCases.findAlbumById({
          albumId: request.params.album_id,
          principal,
        });

        // Identical for both caller kinds: one identity resolved, one query,
        // and nothing in the body saying which kind asked (§9.4).
        return reply.send({
          id: details.album.id,
          title: encodeBase64url(details.album.title),
          created_at: rfc3339(details.album.createdAt),
          media: details.media.map((row) => ({
            id: row.id,
            kind: row.kind,
            status: row.status,
            created_at: rfc3339(row.createdAt),
          })),
        });
      },
    );

    app.get<{ Params: { album_id: string } }>(
      "/albums/:album_id/metadata",
      { schema: getAlbumMetadataSchema, preHandler: requireCaller },
      async (request, reply) => {
        const principal = request.caller;
        if (principal === undefined) throw new ApiError("UNAUTHENTICATED");

        const { metadata } = await deps.useCases.getAlbumMetadata({
          albumId: request.params.album_id,
          principal,
        });

        // The column verbatim — header and chunks — and `no-store` from the
        // plugin hook, which this route needs as ciphertext (§11.3).
        return reply.send({
          metadata: metadata.map((row) => ({
            media_id: row.mediaId,
            envelope: encodeBase64url(row.envelope),
          })),
        });
      },
    );
  };
}
