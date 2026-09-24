/*
 * §9.8's status lookup, and §9.3's scope resolution for a media id.
 * The port's `findById` carries `ownerId` from the `media → albums` join, so
 * the check is one condition — absent and not-yours must be one answer.
 */

import { ApplicationError } from "../errors.js";
import type { MediaRepository, MediaRow } from "../ports/media-repository.js";

export type FindMediaByIdDeps = {
  readonly media: MediaRepository;
};

export type FindMediaByIdMediaInput = {
  readonly mediaId: string;
  readonly ownerId: string;
};

export function findMediaById(deps: FindMediaByIdDeps) {
  return async (input: FindMediaByIdMediaInput): Promise<MediaRow> => {
    const row = await deps.media.findById(input.mediaId);
    if (!row || row.ownerId !== input.ownerId)
      throw new ApplicationError("MEDIA_NOT_FOUND");
    return row;
  };
}
