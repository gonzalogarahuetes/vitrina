import type { AlbumRepository, OwnerAlbum } from "../ports/album-repository.js";

export type ListAlbumsDeps = {
  readonly albums: AlbumRepository;
};

export type ListAlbumsInput = {
  readonly ownerId: string;
};

export function listAlbums(deps: ListAlbumsDeps) {
  return async (input: ListAlbumsInput): Promise<readonly OwnerAlbum[]> => {
    return await deps.albums.listForOwner(input.ownerId);
  };
}
