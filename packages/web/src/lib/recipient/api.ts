/*
 * The recipient's routes, each a row of api-sketch §11.8 and nothing else:
 *
 *   GET /v1/recipient                    §11.4  label for the watermark      no log
 *   GET /v1/recipient/key                §10.1  passphrase wrapping          no log
 *   GET /v1/albums/{album_id}            §9.4   title, statuses              no log
 *   GET /v1/albums/{album_id}/metadata   §9.5   metadata envelopes           album_opened
 *   GET /v1/media/{media_id}/thumbnail   §11.3  thumbnail object             never
 *   GET /v1/media/{media_id}/asset       §11.2  full object, `bytes=0-`      asset_viewed
 *
 * Responses are shape-checked here and nothing is decoded or decrypted: binary
 * fields stay base64url text until the caller decodes them.
 */
import { NetworkFailure, type ApiClient } from "$lib/api/client";
import type { RecipientKeyMaterial } from "$lib/keys/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isUuid = (v: unknown): v is string => isStr(v) && UUID.test(v);
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

export type RecipientRow = {
  readonly id: string;
  readonly album_id: string;
  readonly label: string;
  readonly kind: "qr" | "passphrase";
  readonly created_at: string;
};

export type MediaStatus = "pending" | "processing" | "ready" | "failed";

export type AlbumDetails = {
  readonly id: string;
  readonly title: string;
  readonly created_at: string;
  readonly media: readonly { readonly id: string; readonly kind: string; readonly status: MediaStatus; readonly created_at: string }[];
};

export type AlbumMetadata = {
  readonly metadata: readonly { readonly media_id: string; readonly envelope: string }[];
};

export function isRecipientRow(b: unknown): b is RecipientRow {
  return (
    isObj(b) &&
    isUuid(b["id"]) &&
    isUuid(b["album_id"]) &&
    isStr(b["label"]) &&
    (b["kind"] === "qr" || b["kind"] === "passphrase") &&
    isStr(b["created_at"])
  );
}

export function isKeyMaterial(b: unknown): b is RecipientKeyMaterial {
  return (
    isObj(b) &&
    isStr(b["id"]) &&
    isStr(b["kdf_salt"]) &&
    isStr(b["wrapped"]) &&
    isStr(b["wrap_nonce"]) &&
    isInt(b["kdf_memory_kib"]) &&
    isInt(b["kdf_iterations"]) &&
    isInt(b["kdf_parallelism"])
  );
}

const STATUSES: readonly unknown[] = ["pending", "processing", "ready", "failed"];

export function isAlbumDetails(b: unknown): b is AlbumDetails {
  return (
    isObj(b) &&
    isUuid(b["id"]) &&
    isStr(b["title"]) &&
    isStr(b["created_at"]) &&
    Array.isArray(b["media"]) &&
    b["media"].every((m) => isObj(m) && isUuid(m["id"]) && isStr(m["kind"]) && STATUSES.includes(m["status"]) && isStr(m["created_at"]))
  );
}

export function isAlbumMetadata(b: unknown): b is AlbumMetadata {
  return isObj(b) && Array.isArray(b["metadata"]) && b["metadata"].every((m) => isObj(m) && isUuid(m["media_id"]) && isStr(m["envelope"]));
}

function assertUuid(id: string): string {
  // Ids reach a path only from a response this module already checked, or
  // from uuidFromBytes; this is the last check before one becomes a URL.
  if (!UUID.test(id)) throw new TypeError("not a uuid");
  return id;
}

async function bytes(res: Response): Promise<Uint8Array<ArrayBuffer>> {
  try {
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    // The connection dropped mid-body: the same state as no response at all.
    throw new NetworkFailure("body interrupted");
  }
}

export type RecipientApi = ReturnType<typeof recipientApi>;

export function recipientApi(client: ApiClient, token: string) {
  return {
    recipient: () => client.json({ method: "GET", path: "/v1/recipient", token }, isRecipientRow),
    key: () => client.json({ method: "GET", path: "/v1/recipient/key", token }, isKeyMaterial),
    album: (albumId: string) => client.json({ method: "GET", path: `/v1/albums/${assertUuid(albumId)}`, token }, isAlbumDetails),
    /** Writes `album_opened`. Called on entering the grid and nowhere else (flows §4.1). */
    metadata: (albumId: string) =>
      client.json({ method: "GET", path: `/v1/albums/${assertUuid(albumId)}/metadata`, token }, isAlbumMetadata),
    thumbnail: async (mediaId: string) =>
      bytes(await client.request({ method: "GET", path: `/v1/media/${assertUuid(mediaId)}/thumbnail`, token })),
    /**
     * Writes `asset_viewed`. One request for the whole object: §11.2 refuses a
     * request with no range, and a photo is decrypted whole (`decryptAsset`).
     * Called when the viewer shows this photo, never ahead of it (§11.6).
     */
    asset: async (mediaId: string) =>
      bytes(await client.request({ method: "GET", path: `/v1/media/${assertUuid(mediaId)}/asset`, token, range: "bytes=0-" })),
  };
}
