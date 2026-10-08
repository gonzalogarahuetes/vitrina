import type { AuthenticatedPrincipal } from "../caller.js";
import { ApplicationError } from "../errors.js";
import type {
  AccessLogPage,
  AccessLogQuery,
  AccessLogRepository,
} from "../ports/access-log-repository.js";
import type { AlbumRepository } from "../ports/album-repository.js";
import { resolveAlbumScope } from "../resolve-album-scope.js";

export type GetAccessLogEntriesDeps = {
  readonly albums: AlbumRepository;
  readonly accessLogs: AccessLogRepository;
};

export type GetAccessLogEntriesInput = {
  readonly principal: AuthenticatedPrincipal;
  readonly query: AccessLogQuery;
};

export function getAccessLogEntries(deps: GetAccessLogEntriesDeps) {
  return async (input: GetAccessLogEntriesInput): Promise<AccessLogPage> => {
    const album = await deps.albums.findById(input.query.albumId);

    resolveAlbumScope(
      input.principal,
      input.query.albumId,
      album === null ? null : { ownerId: album.ownerId },
    );

    return deps.accessLogs.listEntries(input.query);
  };
}
