/*
 * §7.3's steps 3 and 4 for an album id — api-sketch §9.3. §9.4, §9.5 and
 * §11's routes resolve identically, so the order lives in one place.
 */

import type { AuthenticatedPrincipal, Caller } from "./caller.js";
import { ApplicationError } from "./errors.js";
import type { AlbumRow } from "./ports/album-repository.js";

/**
 * THE ORDER IS THE RULE: scope, then revocation. A revoked recipient on their
 * own album gets `403`, on any other `404` — checking revocation first
 * confirms the second album exists (brief §9.1).
 */
export function resolveAlbumScope(
  principal: AuthenticatedPrincipal,
  albumId: string,
  album: Pick<AlbumRow, "ownerId"> | null,
): Caller {
  if (principal.kind === "owner") {
    if (album === null || album.ownerId !== principal.ownerId) {
      throw new ApplicationError("ALBUM_NOT_FOUND");
    }
    return { kind: "owner", ownerId: principal.ownerId };
  }

  // The grant names exactly one album, so the path is compared against it.
  if (album === null || principal.grant.albumId !== albumId) {
    throw new ApplicationError("ALBUM_NOT_FOUND");
  }

  // Step 4, and only now: `403` reveals nothing they were not entitled to.
  if (principal.grant.revokedAt !== null) {
    throw new ApplicationError("ALBUM_ACCESS_REVOKED");
  }

  return {
    kind: "recipient",
    recipientId: principal.grant.id,
    albumId: principal.grant.albumId,
  };
}
