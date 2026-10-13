import { objectKey } from "../domain/media/object-key.js";
import { setTimeout as sleep } from "node:timers/promises";
import type { MediaRepository } from "./ports/media-repository.js";
import { StorageError, type ObjectStore } from "./ports/object-store.js";

export type ErasureDeps = {
  media: MediaRepository;
  objectStore: ObjectStore;
  confirmAttempts?: number;
  confirmDelayMs?: number;
};

export type ErasureOutcome =
  | { readonly state: "erased" } // this call deleted the row
  | { readonly state: "gone" } // objects confirmed absent, but another erasure deleted the row first
  | { readonly state: "pending"; readonly failure?: unknown };

export function makeEraseHiddenMedia(deps: ErasureDeps) {
  return async function eraseHiddenMedia(
    mediaId: string,
  ): Promise<ErasureOutcome> {
    try {
      await Promise.all([
        deps.objectStore.remove(objectKey(mediaId, "thumbnail")),
        deps.objectStore.remove(objectKey(mediaId, "asset")),
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
          deps.objectStore.head(objectKey(mediaId, "thumbnail")),
          deps.objectStore.head(objectKey(mediaId, "asset")),
        ]);

        if (!thumbnail && !asset) {
          const erased = await deps.media.erase(mediaId);
          if (erased) return { state: "erased" };
          return {
            state: "gone",
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
      failure: new Error(`object still visible after ${confirmAttempts} HEADs`),
    };
  };
}
