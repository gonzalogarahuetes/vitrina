import type { AuthenticatedPrincipal } from "../caller.js";
import { ApplicationError } from "../errors.js";
import type {
  AccessLogRepository,
  RecipientAccessSummary,
} from "../ports/access-log-repository.js";
import type { AlbumRepository } from "../ports/album-repository.js";
import { resolveAlbumScope } from "../resolve-album-scope.js";

export type GetAccessLogSummaryDeps = {
  readonly albums: AlbumRepository;
  readonly accessLogs: AccessLogRepository;
};

export type GetAccessLogSummaryInput = {
  readonly albumId: string;
  readonly principal: AuthenticatedPrincipal;
};

export function getAccessLogSummary(deps: GetAccessLogSummaryDeps) {
  return async (
    input: GetAccessLogSummaryInput,
  ): Promise<readonly RecipientAccessSummary[]> => {
    const album = await deps.albums.findById(input.albumId);

    resolveAlbumScope(
      input.principal,
      input.albumId,
      album === null ? null : { ownerId: album.ownerId },
    );

    return deps.accessLogs.summarise(input.albumId);
  };
}
