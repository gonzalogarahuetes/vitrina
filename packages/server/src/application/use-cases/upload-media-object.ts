import { Readable } from "node:stream";
import { objectKey, type MediaVariant } from "../../domain/media/object-key.js";
import type { MediaRepository, MediaRow } from "../ports/media-repository.js";
import type { ObjectStore } from "../ports/object-store.js";
import { ApplicationError } from "../errors.js";

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
      );
    } catch (error) {
      await deps.media.markFailed(media.id);
      const row = await deps.media.findById(input.mediaId);
      if (row === null) throwOnNullRow(input.mediaId);

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
        if (row === null) throwOnNullRow(input.mediaId);

        return {
          row,
        };
      }

      if (written.length !== counted) {
        await deps.media.markFailed(media.id);
        const row = await deps.media.findById(input.mediaId);
        if (row === null) throwOnNullRow(input.mediaId);

        return {
          row,
        };
      }

      if (!other) {
        const row = await deps.media.findById(input.mediaId);
        if (row === null) throwOnNullRow(input.mediaId);

        return {
          row,
        };
      }

      await deps.media.markReady(media.id, written.length + other.length);
      const row = await deps.media.findById(input.mediaId);
      if (row === null) throwOnNullRow(input.mediaId);
      return { row };
    } catch (error) {
      const row = await deps.media.findById(input.mediaId);
      if (row === null) throwOnNullRow(input.mediaId);

      return { row, failure: { kind: "confirmation", cause: error } };
    }
  };
}

function throwOnNullRow(mediaId: string): never {
  // Not MEDIA_NOT_FOUND: the row existed and we transitioned it, and §4.2
  // means nothing in v1 deletes one. A broken invariant is a 500 with a
  // stack, which is what the unrecognised branch of the envelope is for.
  throw new Error(`media ${mediaId} vanished between transition and re-read`);
}
