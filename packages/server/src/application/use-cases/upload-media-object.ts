import { Readable } from "node:stream";
import { objectKey, type MediaVariant } from "../../domain/media/object-key.js";
import type { MediaRepository, MediaRow } from "../ports/media-repository.js";
import type { ObjectStore } from "../ports/object-store.js";
import { ApplicationError } from "../errors.js";
import { makeEraseHiddenMedia } from "../erase-hidden-media.js";

export type UploadMediaObjectDeps = {
  readonly media: MediaRepository;
  readonly objectStore: ObjectStore;
};

export type UploadMediaObjectInput = {
  readonly mediaId: string;
  readonly ownerId: string;
  readonly variant: MediaVariant;
  readonly body: Readable;
  readonly length: number;
  /** §9.7's deadline, from the route, carried to the store untouched. */
  readonly signal: AbortSignal;
};

export type UploadOutcome = {
  readonly row: MediaRow; // always the re-read
  readonly failure?: {
    readonly kind: "upload" | "confirmation";
    readonly cause: unknown;
  };
};

export function uploadMediaObject(deps: UploadMediaObjectDeps) {
  return async (input: UploadMediaObjectInput): Promise<UploadOutcome> => {
    const media = await deps.media.findById(input.mediaId);
    if (!media || media.ownerId !== input.ownerId) {
      throw new ApplicationError("MEDIA_NOT_FOUND");
    }

    const upload = await deps.media.beginUpload(media.id);
    if (!upload) throw new ApplicationError("MEDIA_NOT_FOUND");

    if (upload === "already_ready") {
      throw new ApplicationError("MEDIA_ALREADY_READY");
    }

    try {
      let counted = 0;
      async function* counting(source: Readable) {
        for await (const chunk of source) {
          counted += chunk.length;
          yield chunk;
        }
      }

      try {
        await deps.objectStore.put(
          objectKey(media.id, input.variant),
          Readable.from(counting(input.body), { objectMode: false }),
          input.length,
          input.signal,
        );
      } catch (error) {
        await deps.media.markFailed(media.id);
        const row = await deps.media.findById(input.mediaId);
        if (row === null) throwOnNullRow();

        return {
          row,
          failure: {
            kind: "upload",
            cause: error,
          },
        };
      }

      try {
        const written = await deps.objectStore.head(
          objectKey(media.id, input.variant),
        );
        const otherVariant = input.variant === "asset" ? "thumbnail" : "asset";
        const other = await deps.objectStore.head(
          objectKey(media.id, otherVariant),
        );

        if (!written) {
          const row = await deps.media.findById(input.mediaId);
          if (row === null) throwOnNullRow();

          return {
            row,
          };
        }

        if (written.length !== counted) {
          await deps.media.markFailed(media.id);
          const row = await deps.media.findById(input.mediaId);
          if (row === null) throwOnNullRow();

          return {
            row,
          };
        }

        if (!other) {
          const row = await deps.media.findById(input.mediaId);
          if (row === null) throwOnNullRow();

          return {
            row,
          };
        }

        await deps.media.markReady(media.id, written.length + other.length);
        const row = await deps.media.findById(input.mediaId);
        if (row === null) throwOnNullRow();
        return { row };
      } catch (error) {
        const row = await deps.media.findById(input.mediaId);
        if (row === null) throwOnNullRow();

        return { row, failure: { kind: "confirmation", cause: error } };
      }
    } finally {
      const end = await deps.media.endUpload(media.id);
      if (end.state === "removed") {
        if (end.uploadsInFlight === 0) {
          const erased = await makeEraseHiddenMedia(deps)(media.id);
          if (erased.state === "pending") {
            throw new ApplicationError("MEDIA_NOT_FOUND", {
              cause: erased.failure,
            });
          } else {
            throw new ApplicationError("MEDIA_NOT_FOUND");
          }
        }
        throw new ApplicationError("MEDIA_NOT_FOUND");
      }
    }
  };
}

/*
 * A null re-read means the row was hidden mid-request by §9.11's removal —
 * not a broken invariant, which it was while nothing deleted a row. The
 * `finally`'s endUpload sees the same hide and throws this same 404, so the
 * choice of error here does not reach the client.
 */
function throwOnNullRow(): never {
  throw new ApplicationError("MEDIA_NOT_FOUND");
}
