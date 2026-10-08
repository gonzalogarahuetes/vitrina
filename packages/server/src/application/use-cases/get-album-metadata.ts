/*
 * §9.5's metadata envelopes — api-sketch §9.3, §9.5. One request returns every
 * one: a client needs the dimensions inside them before it can draw a grid.
 */

import type { AuthenticatedPrincipal, Caller } from "../caller.js";
import type { AccessLogRepository } from "../ports/access-log-repository.js";
import type { AlbumRepository } from "../ports/album-repository.js";
import type {
  MediaEnvelope,
  MediaRepository,
} from "../ports/media-repository.js";
import { resolveAlbumScope } from "../resolve-album-scope.js";

export type GetAlbumMetadataDeps = {
  readonly albums: AlbumRepository;
  readonly media: MediaRepository;
  readonly accessLogs: AccessLogRepository;
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
  /** As §9.4's. The log write is the only branch on its `kind` (§11.6). */
  readonly caller: Caller;
  /** §11.6: the fetch is served anyway; the route logs this at `error`. */
  readonly logFailure?: unknown;
};

export function getAlbumMetadata(deps: GetAlbumMetadataDeps) {
  return async (input: GetAlbumMetadataInput): Promise<AlbumMetadata> => {
    const album = await deps.albums.findById(input.albumId);
    const caller = resolveAlbumScope(input.principal, input.albumId, album);

    const metadata = await deps.media.listReadyEnvelopes(input.albumId);

    let logFailure: unknown;
    if (caller.kind === "recipient") {
      try {
        await deps.accessLogs.record({
          event: "album_opened",
          recipientId: caller.recipientId,
        });
      } catch (error) {
        // A failed write does not fail the fetch; the route logs it.
        logFailure = error;
      }
    }

    return logFailure === undefined
      ? { metadata, caller }
      : { metadata, caller, logFailure };
  };
}
