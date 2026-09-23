import type {
  AlbumRepository,
  CreatedAlbum,
  NewAlbum,
} from "../ports/album-repository.js";

export type CreateAlbumDeps = {
  readonly albums: AlbumRepository;
};

export type CreateAlbumInput = NewAlbum;

export function createAlbum(deps: CreateAlbumDeps) {
  return async (input: CreateAlbumInput): Promise<CreatedAlbum> => {
    return await deps.albums.create(input);
  };
}
