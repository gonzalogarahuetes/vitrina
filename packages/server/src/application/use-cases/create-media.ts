import { ApplicationError } from "../errors.js";
import type { AlbumRepository } from "../ports/album-repository.js";
import type {
  CreatedMedia,
  MediaRepository,
  NewMedia,
} from "../ports/media-repository.js";

export type CreateMediaDeps = {
  readonly albums: AlbumRepository;
  readonly media: MediaRepository;
};

export type CreateMediaInput = NewMedia & { readonly ownerId: string };

export function createMedia(deps: CreateMediaDeps) {
  return async (input: CreateMediaInput): Promise<CreatedMedia> => {
    const album = await deps.albums.findById(input.albumId);
    if (!album || album.ownerId !== input.ownerId) {
      throw new ApplicationError("ALBUM_NOT_FOUND");
    }

    return await deps.media.create({
      id: input.id,
      albumId: input.albumId,
      kind: input.kind,
      metadata: input.metadata,
    });
  };
}
