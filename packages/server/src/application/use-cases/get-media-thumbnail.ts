// GET /v1/media/{id}/thumbnail — api-sketch §11.3. §7.3's ladder, THEN the
// `ready` check: a revoked recipient gets 403 even for a pending row, or the
// two answers would tell them which photographs are ready. Never logged.

import { objectKey } from "../../domain/media/object-key.js";
import type { AuthenticatedPrincipal } from "../caller.js";
import { ApplicationError } from "../errors.js";
import type { MediaRepository } from "../ports/media-repository.js";
import {
  StorageError,
  type ObjectBody,
  type ObjectStore,
} from "../ports/object-store.js";
import { resolveAlbumScope } from "../resolve-album-scope.js";

export type GetMediaThumbnailDeps = {
  readonly media: MediaRepository;
  readonly objectStore: ObjectStore;
};

export type GetMediaThumbnailInput = {
  readonly mediaId: string;
  readonly principal: AuthenticatedPrincipal;
};

export function getMediaThumbnail(deps: GetMediaThumbnailDeps) {
  return async (input: GetMediaThumbnailInput): Promise<ObjectBody> => {
    const media = await deps.media.findById(input.mediaId);
    if (!media) throw new ApplicationError("MEDIA_NOT_FOUND");

    resolveAlbumScope(input.principal, media.albumId, {
      ownerId: media.ownerId,
    });

    if (media.status !== "ready") {
      throw new ApplicationError("MEDIA_NOT_FOUND");
    }

    try {
      return await deps.objectStore.get(objectKey(media.id, "thumbnail"));
    } catch (error) {
      // A broken invariant, not a 404: `ready` means both HEADs passed (§9.7)
      // and nothing deletes. A plain Error logs a stack (§1.2).
      if (error instanceof StorageError && error.code === "NOT_FOUND") {
        throw new Error("ready media has no thumbnail object", {
          cause: error,
        });
      }
      throw error;
    }
  };
}
