// The routes that serve stored ciphertext — api-sketch §11.2, §11.3. Separate
// from media.ts so the `no-store` hook covers them and nothing else there.

import type { FastifyInstance } from "fastify";
import type { UseCases } from "../../../../application/use-cases/index.js";
import { ApiError } from "../error-envelope.js";
import { makeRequireOwnerOrRecipient } from "../auth/either.js";
import {
  getMediaAssetSchema,
  getMediaThumbnailSchema,
} from "../schemas/delivery.js";
import { parseRange } from "../range.js";
import { StorageError } from "../../../../application/ports/object-store.js";
import { chargeBytes } from "../token-limiter.js";

export type DeliveryRoutesDeps = {
  readonly useCases: UseCases;
};

export function deliveryRoutes(deps: DeliveryRoutesDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    const requireOwnerOrRecipient = makeRequireOwnerOrRecipient(deps.useCases);

    // Every response here carries ciphertext, so the plugin sets `no-store`
    // (§11.3): a route added to this plugin inherits it by living here.
    app.addHook("onSend", async (_request, reply) => {
      reply.header("Cache-Control", "no-store");
    });

    app.get<{ Params: { media_id: string } }>(
      "/media/:media_id/thumbnail",
      {
        schema: getMediaThumbnailSchema,
        // Owner OR recipient (§7.1's tagged Caller); the use case runs §7.3.
        preHandler: requireOwnerOrRecipient,
        config: { chargesByteBudget: true },
      },
      async (request, reply) => {
        const principal = request.caller;
        if (!principal) throw new ApiError("UNAUTHENTICATED");

        const { body, contentLength } = await deps.useCases.getMediaThumbnail({
          mediaId: request.params.media_id,
          principal,
        });

        // §11.5's top-up, with the store's figure, before a byte goes out.
        chargeBytes(request, contentLength);

        // The whole object; `Range` is never read (§11.3). Content-Length is
        // set by hand because Fastify cannot know a stream's length.
        return reply
          .code(200)
          .header("Content-Type", "application/octet-stream")
          .header("Content-Length", contentLength)
          .send(body);
      },
    );

    app.get<{ Params: { media_id: string } }>(
      "/media/:media_id/asset",
      {
        schema: getMediaAssetSchema,
        // Every response from this route, 401 and 400 included (§11.2).
        onRequest: async (_request, reply) => {
          reply.header("Accept-Ranges", "bytes");
        },
        preHandler: requireOwnerOrRecipient,
        config: { chargesByteBudget: true },
      },
      async (request, reply) => {
        const principal = request.caller;
        if (!principal) throw new ApiError("UNAUTHENTICATED");

        // Syntax only, before the use case: a bad range never reaches the
        // store or the log. No `details` — a Range value is request content (#15).
        const range = parseRange(request.headers.range);

        if (!range) throw new ApiError("VALIDATION_FAILED");

        let asset;
        try {
          asset = await deps.useCases.getMediaAsset({
            mediaId: request.params.media_id,
            principal,
            range,
          });
        } catch (error) {
          // Only the store knows the size; its 416 is mapped here, where the
          // `Content-Range: bytes */size` header can be written (§11.2).
          if (error instanceof StorageError && error.code === "INVALID_RANGE") {
            reply.header("Content-Range", `bytes */${error.objectSize}`);
            throw new ApiError("RANGE_NOT_SATISFIABLE");
          }
          throw error;
        }
        const { object, logFailure } = asset;

        if (logFailure !== undefined) {
          request.log.error({ err: logFailure }, "access_log write failed");
        }

        const served = object.contentRange;
        if (served === undefined)
          throw new Error("ranged get returned no contentRange"); // broken invariant → 500

        chargeBytes(request, object.contentLength);

        // Always 206: the store's range, rendered verbatim in value, and
        // nothing it added — ETag and x-amz-* have no slot in ObjectBody.
        return reply
          .code(206)
          .header("Content-Type", "application/octet-stream")
          .header("Content-Length", object.contentLength)
          .header(
            "Content-Range",
            `bytes ${served.start}-${served.end}/${served.size}`,
          )
          .send(object.body);
      },
    );
  };
}
