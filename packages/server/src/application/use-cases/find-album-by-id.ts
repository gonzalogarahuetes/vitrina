/*
 * §9.4's album details — api-sketch §9.3, §9.4. Owner OR recipient, resolved
 * to one identity first. Two repositories, because no aggregate holds both.
 */

import type { AuthenticatedPrincipal, Caller } from "../caller.js";
import type { AlbumRepository, AlbumRow } from "../ports/album-repository.js";
import type {
  MediaListing,
  MediaRepository,
} from "../ports/media-repository.js";
import { resolveAlbumScope } from "../resolve-album-scope.js";

export type FindAlbumByIdDeps = {
  readonly albums: AlbumRepository;
  readonly media: MediaRepository;
};

export type FindAlbumByIdInput = {
  readonly albumId: string;
  readonly principal: AuthenticatedPrincipal;
};

export type AlbumDetails = {
  readonly album: AlbumRow;
  /** Every row, whatever its status — §9.4. The client hides what is not ready. */
  readonly media: readonly MediaListing[];
  /**
   * For PR 5's access log — written for recipients, not owners — and its only
   * consumer. NOTHING MAY BRANCH ON `kind`: §9.4's body is byte-identical.
   */
  readonly caller: Caller;
};

export function findAlbumById(deps: FindAlbumByIdDeps) {
  return async (input: FindAlbumByIdInput): Promise<AlbumDetails> => {
    const album = await deps.albums.findById(input.albumId);
    const caller = resolveAlbumScope(input.principal, input.albumId, album);

    // resolveAlbumScope throws unless the album is in scope, so it is here.
    return {
      album: album as AlbumRow,
      media: await deps.media.listByAlbum(input.albumId),
      caller,
    };
  };
}
