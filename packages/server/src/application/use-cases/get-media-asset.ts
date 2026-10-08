// GET /v1/media/{id}/asset — api-sketch §11.2, §11.6. The thumbnail's ladder,
// then a ranged get; the store's INVALID_RANGE passes through, because only
// the route can write the 416's Content-Range.

import { objectKey } from "../../domain/media/object-key.js";
import type { AuthenticatedPrincipal } from "../caller.js";
import { ApplicationError } from "../errors.js";
import type { AccessLogRepository } from "../ports/access-log-repository.js";
import type { MediaRepository } from "../ports/media-repository.js";
import {
  StorageError,
  type ByteRange,
  type ObjectBody,
  type ObjectStore,
} from "../ports/object-store.js";
import { resolveAlbumScope } from "../resolve-album-scope.js";

export type GetMediaAssetDeps = {
  readonly media: MediaRepository;
  readonly objectStore: ObjectStore;
  readonly accessLogs: AccessLogRepository;
};

export type GetMediaAssetInput = {
  readonly mediaId: string;
  readonly principal: AuthenticatedPrincipal;
  readonly range: ByteRange;
};

export type MediaAsset = {
  readonly object: ObjectBody;
  /** §11.6: the fetch is served anyway; the route logs this at `error`. */
  readonly logFailure?: unknown;
};

export function getMediaAsset(deps: GetMediaAssetDeps) {
  return async (input: GetMediaAssetInput): Promise<MediaAsset> => {
    const media = await deps.media.findById(input.mediaId);
    if (!media) throw new ApplicationError("MEDIA_NOT_FOUND");

    const caller = resolveAlbumScope(input.principal, media.albumId, {
      ownerId: media.ownerId,
    });

    if (media.status !== "ready") {
      throw new ApplicationError("MEDIA_NOT_FOUND");
    }

    try {
      const object = await deps.objectStore.get(
        objectKey(media.id, "asset"),
        input.range,
      );

      // §11.6: a range from byte 0 fetches the header, so it IS the open. Only
      // after the store answered, so no 4xx or 500 logs; never deduplicated.
      let logFailure: unknown;
      if (caller.kind === "recipient" && input.range.start === 0) {
        try {
          await deps.accessLogs.record({
            event: "asset_viewed",
            recipientId: caller.recipientId,
            mediaId: media.id,
          });
        } catch (error) {
          // A failed write does not fail the fetch; the route logs it.
          logFailure = error;
        }
      }
      return logFailure === undefined ? { object } : { object, logFailure };
    } catch (error) {
      // A broken invariant, not a 404: `ready` means both HEADs passed (§9.7)
      // and nothing deletes. A plain Error logs a stack (§1.2).
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        throw new Error("ready media has no asset object", {
          cause: error,
        });
      }
      throw error;
    }
  };
}
