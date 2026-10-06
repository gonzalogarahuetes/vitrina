import type { AlbumRepository } from "../ports/album-repository.js";
import type {
  CreatedRecipient,
  NewRecipient,
  RecipientRepository,
} from "../ports/recipient-repository.js";
import { resolveAlbumScope } from "../resolve-album-scope.js";

export type CreateRecipientDeps = {
  readonly albums: AlbumRepository;
  readonly recipients: RecipientRepository;
};

export type CreateRecipientInput = {
  readonly ownerId: string;
  readonly recipient: NewRecipient;
};

export function createRecipient(deps: CreateRecipientDeps) {
  return async (input: CreateRecipientInput): Promise<CreatedRecipient> => {
    const album = await deps.albums.findById(input.recipient.albumId);

    resolveAlbumScope(
      { kind: "owner", ownerId: input.ownerId },
      input.recipient.albumId,
      album,
    );

    return await deps.recipients.create(input.recipient);
  };
}
