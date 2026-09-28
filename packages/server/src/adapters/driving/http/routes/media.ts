/*
 * The media routes — api-sketch §9.6's create, §9.7's two uploads, §9.8's
 * status. Each handler decodes the wire, calls one use case, and encodes the
 * result back; the status ladder and the confirming HEADs are inward of here.
 *
 * NO `no-store` HOOK. Nothing this plugin returns carries a wrapping or
 * ciphertext — §9.6's `201` and §9.8's status object are identifiers and a
 * state. Copying §8.3's header here would make a decision look like a default,
 * which §11.3 argues against; a route that needs it adds it and says why.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { makeRequireOwner } from "../auth/owner.js";
import { decodeRangeOr400 } from "../decode-field.js";
import { ApiError } from "../error-envelope.js";
import { rfc3339 } from "../rfc3339.js";
import {
  createMediaSchema,
  getMediaSchema,
  uploadAssetSchema,
  uploadThumbnailSchema,
} from "../schemas/media.js";
import type { MediaRow } from "../../../../application/ports/media-repository.js";
import type { Readable } from "node:stream";
import type { MediaVariant } from "../../../../domain/media/object-key.js";
import type { UploadOutcome } from "../../../../application/use-cases/upload-media-object.js";

export type MediaRoutesDeps = {
  readonly useCases: UseCases;
};

type CreateMediaBody = {
  id: string;
  kind: "photo";
  metadata: string;
};

const ASSET_MAX_BYTES = 16 * 1024 * 1024;
const ENVELOPE_MIN_BYTES = 81;
const THUMBNAIL_MAX_BYTES = 1024 * 1024;
const UPLOAD_DEADLINE_MS = 120_000; // §9.7, provisional

type UploadRoute = { Body: Readable; Params: { media_id: string } };
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

    /**
     * ONE handler for both objects, parameterised — §9.7's "one handler serves
     * both variants without caring which it is". §6.2 names the alternative as
     * the bug: a handler written for the asset and copied for the thumbnail,
     * which marks `ready` on the first object. Copying is what this prevents.
     *
     * `maxBytes` is per variant; the FLOOR is not. 81 bytes is a property of
     * the envelope format — 64-byte header, one chunk, 16-byte tag — and is
     * the same for both, so parameterising it would be as wrong as sharing
     * the ceiling.
     */
    const upload = (variant: MediaVariant, maxBytes: number) =>
      async function handler(
        request: FastifyRequest<{
          Body: Readable;
          Params: { media_id: string };
        }>,
        reply: FastifyReply,
      ) {
        const caller = request.caller;
        if (caller?.kind !== "owner") throw new ApiError("UNAUTHENTICATED");

        if (!request.headers["content-length"]) {
          throw new ApiError("LENGTH_REQUIRED");
        }

        const contentLength = Number(request.headers["content-length"]);

        // Not `NaN > max`, which is false and would let a malformed framing
        // through every check below it.
        if (!Number.isInteger(contentLength) || contentLength < 0) {
          throw new ApiError("VALIDATION_FAILED");
        }

        if (contentLength > maxBytes) {
          throw new ApiError("PAYLOAD_TOO_LARGE");
        }

        // §9.7's floor, and the one check the confirming HEAD cannot back up:
        // a zero-length body compares 0 against a count of 0 and would reach
        // `ready`, which is the only false `ready` the evidence rule admits.
        if (contentLength < ENVELOPE_MIN_BYTES) {
          throw new ApiError("VALIDATION_FAILED");
        }

        /*
         * The deadline is a timer here, not `requestTimeout` — measured, that
         * one answers `408` itself, and §9.7 needs the handler to mark the row
         * and answer nothing. Destroying the body propagates through the
         * counting generator, so `put` rejects and the use case's own catch
         * marks `failed`: no extra branch in the ladder.
         */
        let timedOut = false;
        const deadline = setTimeout(() => {
          timedOut = true;
          request.body.destroy(new Error("upload deadline"));
        }, UPLOAD_DEADLINE_MS);

        let outcome: UploadOutcome;
        try {
          outcome = await deps.useCases.uploadMediaObject({
            mediaId: request.params.media_id,
            ownerId: caller.ownerId,
            variant,
            body: request.body,
            length: contentLength,
          });
        } finally {
          clearTimeout(deadline);
        }

        /*
         * `raw.complete` is the signal, measured: false when the deadline
         * fired and when the client vanished, true when the store refused with
         * the client still connected. `raw.destroyed` is true on the success
         * path too and cannot be used (§9.7).
         */
        if (!request.raw.complete) {
          request.log.warn(
            { mediaId: request.params.media_id, variant, timedOut },
            "upload did not complete; answering nothing",
          );
          return reply.hijack();
        }

        if (outcome.failure?.kind === "confirmation") {
          // §9.7: the row looks identical to one behind a merely slow store,
          // and this line is the only place the two differ.
          request.log.error(
            {
              err: outcome.failure.cause,
              mediaId: request.params.media_id,
              variant,
            },
            "confirming HEAD failed; row left processing",
          );
        }

        if (outcome.failure?.kind === "upload") {
          request.log.error(
            {
              err: outcome.failure.cause,
              mediaId: request.params.media_id,
              variant,
            },
            "the store refused the object; row is failed",
          );
        }

        // `200` even for a `failed` row: the request succeeded and the server
        // is reporting its opinion of the bytes (§9.7).
        return reply.code(200).send(statusBody(outcome.row));
      };

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

    /*
     * §9.7's two uploads, in a scope of their own so the parser surgery reaches
     * them and nothing else. Measured: registering a parser does NOT displace
     * Fastify's defaults, it adds a third — `application/json` would still
     * reach the default parser and `text/plain` would reach the HANDLER, with
     * `request.body` a string, on which the deadline's `destroy()` fails and
     * the counting generator iterates characters.
     *
     * It cannot be done one level up: §9.6's create needs the JSON parser.
     *
     * Handing the raw stream through is also why `bodyLimit` cannot help — it
     * is applied by the parsers that accumulate a body, so the limits below
     * are the handler's (§9.7).
     */
    await app.register(async (uploads) => {
      uploads.removeAllContentTypeParsers();
      uploads.addContentTypeParser(
        "application/octet-stream",
        (req, payload, done) => done(null, payload),
      );

      uploads.put<UploadRoute>(
        "/media/:media_id/asset",
        { schema: uploadAssetSchema, preHandler: requireOwner },
        upload("asset", ASSET_MAX_BYTES),
      );
      uploads.put<UploadRoute>(
        "/media/:media_id/thumbnail",
        { schema: uploadThumbnailSchema, preHandler: requireOwner },
        upload("thumbnail", THUMBNAIL_MAX_BYTES),
      );
    });
  };
}
