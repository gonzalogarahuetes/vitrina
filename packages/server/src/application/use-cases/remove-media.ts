import { setTimeout as sleep } from "node:timers/promises";
import { objectKey } from "../../domain/media/object-key.js";
import { ApplicationError } from "../errors.js";
import type { MediaRepository } from "../ports/media-repository.js";
import { StorageError, type ObjectStore } from "../ports/object-store.js";
import { makeEraseHiddenMedia } from "../erase-hidden-media.js";

export type RemoveMediaDeps = {
  readonly media: MediaRepository;
  readonly objectStore: ObjectStore;
  readonly confirmAttempts?: number;
  readonly confirmDelayMs?: number;
};

export type RemoveMediaInput = {
  readonly mediaId: string;
  readonly ownerId: string;
};

export type RemovedMedia = {
  state: "erased" | "pending";
  failure?: unknown;
};

export function removeMedia(deps: RemoveMediaDeps) {
  return async (input: RemoveMediaInput): Promise<RemovedMedia> => {
    const media = await deps.media.hide(input.mediaId, input.ownerId);
    if (!media) throw new ApplicationError("MEDIA_NOT_FOUND");

    if (media.uploadsInFlight > 0) return { state: "pending" };

    const erased = await makeEraseHiddenMedia(deps)(media.id);
    if (erased.state === "pending") {
      return { state: erased.state, failure: erased.failure };
    }
    if (erased.state === "gone") throw new ApplicationError("MEDIA_NOT_FOUND");
    return { state: erased.state };
  };
}
