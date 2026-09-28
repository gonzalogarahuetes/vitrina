/*
 * §9.5's metadata envelopes — api-sketch §9.3, §9.5. One request returns every
 * one: a client needs the dimensions inside them before it can draw a grid.
 */

import type { AuthenticatedPrincipal, Caller } from "../caller.js";
import type { AlbumRepository } from "../ports/album-repository.js";
import type {
  MediaEnvelope,
  MediaRepository,
} from "../ports/media-repository.js";
import { resolveAlbumScope } from "../resolve-album-scope.js";

export type GetAlbumMetadataDeps = {
  readonly albums: AlbumRepository;
  readonly media: MediaRepository;
};

export type GetAlbumMetadataInput = {
  readonly albumId: string;
  readonly principal: AuthenticatedPrincipal;
};

export type AlbumMetadata = {
  /**
   * `ready` rows only, filtered in SQL. Not a caller-kind filter — the same
   * for owners; a `pending` row describes an asset that does not exist yet.
   */
  readonly metadata: readonly MediaEnvelope[];
  /** As §9.4's: PR 5's access log, and nothing here branches on it. */
  readonly caller: Caller;
};

export function getAlbumMetadata(deps: GetAlbumMetadataDeps) {
  return async (input: GetAlbumMetadataInput): Promise<AlbumMetadata> => {
    const album = await deps.albums.findById(input.albumId);
    const caller = resolveAlbumScope(input.principal, input.albumId, album);

    return {
      metadata: await deps.media.listReadyEnvelopes(input.albumId),
      caller,
    };
  };
}
