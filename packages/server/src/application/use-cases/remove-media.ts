import { setTimeout as sleep } from "node:timers/promises";
import { objectKey } from "../../domain/media/object-key.js";
import { ApplicationError } from "../errors.js";
import type { MediaRepository } from "../ports/media-repository.js";
import { StorageError, type ObjectStore } from "../ports/object-store.js";

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

    try {
      await Promise.all([
        deps.objectStore.remove(objectKey(media.id, "thumbnail")),
        deps.objectStore.remove(objectKey(media.id, "asset")),
      ]);
    } catch (error) {
      if (error instanceof StorageError) {
        return {
          state: "pending",
          failure: error,
        };
      }
      throw error;
    }

    const confirmAttempts = deps.confirmAttempts ?? 3;
    for (let index = 0; index < confirmAttempts; index++) {
      try {
        const [thumbnail, asset] = await Promise.all([
          deps.objectStore.head(objectKey(media.id, "thumbnail")),
          deps.objectStore.head(objectKey(media.id, "asset")),
        ]);

        if (!thumbnail && !asset) {
          // we ignore the result of `erase` since false can only mean a concurrent DELETE erased the row first
          await deps.media.erase(media.id);

          return {
            state: "erased",
          };
        }
      } catch (error) {
        if (error instanceof StorageError) {
          return {
            state: "pending",
            failure: error,
          };
        }
        throw error;
      }

      if (index < confirmAttempts - 1) {
        await sleep(deps.confirmDelayMs ?? 10);
      }
    }

    return {
      state: "pending",
    };
  };
}
