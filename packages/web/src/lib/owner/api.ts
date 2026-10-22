/*
 * The owner's routes for sign-up, sign-in, unlock, the album list and logout,
 * each one a row of api-sketch §11.8:
 *
 *   POST /v1/signup          §7.5   email as typed, proof, salt, params, wrapping
 *   POST /v1/login/params    §7.5   email as typed → salt and params
 *   POST /v1/login           §7.5   email as typed, proof → token, expires_at
 *   GET  /v1/owner/key       §8.3   the wrapped K_master
 *   GET  /v1/albums          §9.2   every album and its wrapping
 *   POST /v1/albums          §9.2   create: id, title, wrapping
 *   GET  /v1/albums/{id}                  §9.4   statuses
 *   GET  /v1/albums/{id}/metadata         §9.5   metadata envelopes (ready only)
 *   POST /v1/albums/{id}/media            §9.6   create: id, kind, metadata envelope
 *   PUT  /v1/media/{id}/asset|thumbnail   §9.7   the envelopes, octet-stream
 *   GET  /v1/media/{id}                   §9.8   status, updated_at
 *   DELETE /v1/media/{id}                 §9.11  204 erased · 202 pending
 *   GET  /v1/media/{id}/thumbnail|asset   §11.3, §11.2
 *   GET  /v1/albums/{id}/access-log       §11.7  per-recipient summary (labels as ciphertext)
 *   GET  /v1/albums/{id}/access-log/entries  §11.7  entries, paged by `before`
 *   POST /v1/albums/{id}/recipients       §7.7   create: id, kind, label, token_hash, wrapping
 *   POST /v1/recipients/{id}/revoke       §7.8   no body, no Content-Type
 *   POST /v1/logout          §7.5   no body, no Content-Type
 *   POST /v1/logout/all      §7.5   no body, no Content-Type
 *
 * The email is sent exactly as typed. Nothing here trims it, lowercases it or
 * normalises it (encryption spec §6.6; api-sketch §7.5).
 *
 * Bytes are encoded to base64url here and nowhere else. The proof's encoded
 * copy is a JavaScript string, and so is the JSON body built from it. Neither
 * can be wiped. Zeroing the caller's Uint8Array is all the platform allows
 * (api-sketch §8.4).
 */
import { NetworkFailure, UnexpectedResponse, type ApiClient } from "$lib/api/client";
import type { AlbumWrapping, LoginParams, OwnerKeyMaterial } from "$lib/keys/owner-types";
import { isAlbumDetails, isAlbumMetadata, type MediaStatus } from "$lib/recipient/api";
import { encodeBase64url, type KdfParameters } from "@vitrina/shared";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isTime = (v: unknown): v is string => isStr(v) && RFC3339_UTC.test(v) && !Number.isNaN(Date.parse(v));

export type Session = { readonly token: string; readonly expires_at: string };

export type AlbumRow = AlbumWrapping & {
  readonly title: string;
  readonly created_at: string;
  readonly media_count: number;
};

const isSession = (b: unknown): b is Session => isObj(b) && isStr(b["token"]) && TOKEN.test(b["token"]) && isTime(b["expires_at"]);

const isLoginParams = (b: unknown): b is LoginParams =>
  isObj(b) && isStr(b["kdf_salt"]) && isInt(b["kdf_memory_kib"]) && isInt(b["kdf_iterations"]) && isInt(b["kdf_parallelism"]);

export const isOwnerKeyMaterial = (b: unknown): b is OwnerKeyMaterial =>
  isLoginParams(b) && isStr((b as Obj)["wrapped_master"]) && isStr((b as Obj)["wrap_nonce"]);

const isAlbumRow = (a: unknown): a is AlbumRow =>
  isObj(a) &&
  isStr(a["id"]) &&
  UUID.test(a["id"]) &&
  isStr(a["title"]) &&
  isStr(a["created_at"]) &&
  isStr(a["wrapped_key"]) &&
  isStr(a["wrap_nonce"]) &&
  isInt(a["media_count"]) &&
  a["media_count"] >= 0;

export const isAlbumList = (b: unknown): b is { albums: AlbumRow[] } =>
  isObj(b) && Array.isArray(b["albums"]) && b["albums"].every(isAlbumRow);

const isCreated = (b: unknown): b is { id: string; created_at: string } => isObj(b) && isStr(b["id"]) && isStr(b["created_at"]);

const STATUSES: readonly unknown[] = ["pending", "processing", "ready", "failed"];

/** §9.8's status object, which §9.7's uploads also return. */
export type MediaStatusBody = {
  readonly id: string;
  readonly album_id: string;
  readonly kind: string;
  readonly status: MediaStatus;
  readonly byte_size: number | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export const isMediaStatus = (b: unknown): b is MediaStatusBody =>
  isObj(b) &&
  isStr(b["id"]) &&
  UUID.test(b["id"]) &&
  isStr(b["album_id"]) &&
  isStr(b["kind"]) &&
  STATUSES.includes(b["status"]) &&
  (b["byte_size"] === null || isInt(b["byte_size"])) &&
  isTime(b["created_at"]) &&
  isTime(b["updated_at"]);

const isCreatedMedia = (b: unknown): b is { id: string; status: MediaStatus; created_at: string } =>
  isObj(b) && isStr(b["id"]) && STATUSES.includes(b["status"]) && isTime(b["created_at"]);

/** §11.7's per-recipient summary. `label` stays ciphertext (base64url) until K_label opens it. */
export type AccessLogRecipient = {
  readonly recipient_id: string;
  readonly label: string;
  readonly revoked_at: string | null;
  readonly album_opens: number;
  readonly media_opened: number;
  readonly last_opened_at: string | null;
};

export type AccessLogSummary = { readonly recipients: readonly AccessLogRecipient[] };

const isCount = (v: unknown): v is number => isInt(v) && v >= 0;
const isTimeOrNull = (v: unknown): boolean => v === null || isTime(v);

const isAccessLogRecipient = (r: unknown): r is AccessLogRecipient =>
  isObj(r) &&
  isStr(r["recipient_id"]) &&
  UUID.test(r["recipient_id"]) &&
  isStr(r["label"]) &&
  isTimeOrNull(r["revoked_at"]) &&
  isCount(r["album_opens"]) &&
  isCount(r["media_opened"]) &&
  isTimeOrNull(r["last_opened_at"]);

const isAccessLog = (b: unknown): b is AccessLogSummary => isObj(b) && Array.isArray(b["recipients"]) && b["recipients"].every(isAccessLogRecipient);

export type AccessLogEvent = "album_opened" | "asset_viewed";

/** One §11.7 entry. `media_id` is null for `album_opened`. */
export type AccessLogEntry = {
  readonly id: number;
  readonly recipient_id: string;
  readonly media_id: string | null;
  readonly event: AccessLogEvent;
  readonly occurred_at: string;
};

export type AccessLogPage = { readonly entries: readonly AccessLogEntry[]; readonly next_before: number | null };

const isAccessLogEntry = (e: unknown): e is AccessLogEntry =>
  isObj(e) &&
  isCount(e["id"]) &&
  isStr(e["recipient_id"]) &&
  UUID.test(e["recipient_id"]) &&
  (e["event"] === "album_opened" ? e["media_id"] === null : e["event"] === "asset_viewed" && isStr(e["media_id"]) && UUID.test(e["media_id"])) &&
  isTime(e["occurred_at"]);

const isAccessLogPage = (b: unknown): b is AccessLogPage =>
  isObj(b) && Array.isArray(b["entries"]) && b["entries"].every(isAccessLogEntry) && (b["next_before"] === null || isCount(b["next_before"]));

/** §7.7's body. Every binary field is bytes here and encoded below; nothing in it is key material (api-sketch §4.1). */
export type NewRecipientBody =
  | {
      readonly id: string;
      readonly kind: "qr";
      /** Ciphertext under K_label(id). */
      readonly label: Uint8Array;
      readonly tokenHash: Uint8Array;
      readonly wrapped: Uint8Array;
      readonly wrapNonce: Uint8Array;
    }
  | {
      readonly id: string;
      readonly kind: "passphrase";
      readonly label: Uint8Array;
      readonly tokenHash: Uint8Array;
      readonly wrapped: Uint8Array;
      readonly wrapNonce: Uint8Array;
      readonly kdfSalt: Uint8Array;
      readonly params: KdfParameters;
    };

const isRevoked = (b: unknown): b is { revoked_at: string } => isObj(b) && isTime(b["revoked_at"]);

function assertUuid(id: string): string {
  // The last check before an id becomes part of a URL path.
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

export type SignupBody = {
  readonly email: string;
  readonly proof: Uint8Array;
  readonly kdfSalt: Uint8Array;
  readonly params: KdfParameters;
  readonly wrappedMaster: Uint8Array;
  readonly wrapNonce: Uint8Array;
};

export type NewAlbumBody = {
  readonly id: string;
  readonly title: Uint8Array;
  readonly wrappedKey: Uint8Array;
  readonly wrapNonce: Uint8Array;
};

export type OwnerApi = ReturnType<typeof ownerApi>;

export function ownerApi(client: ApiClient) {
  return {
    signup: (b: SignupBody) =>
      client.json(
        {
          method: "POST",
          path: "/v1/signup",
          json: {
            email: b.email,
            proof: encodeBase64url(b.proof),
            kdf_salt: encodeBase64url(b.kdfSalt),
            kdf_memory_kib: b.params.memoryKib,
            kdf_iterations: b.params.iterations,
            kdf_parallelism: b.params.parallelism,
            wrapped_master: encodeBase64url(b.wrappedMaster),
            wrap_nonce: encodeBase64url(b.wrapNonce),
          },
        },
        (r): r is Session => isSession(r) && isStr((r as Obj)["id"]),
      ),
    loginParams: (email: string) => client.json({ method: "POST", path: "/v1/login/params", json: { email } }, isLoginParams),
    login: (email: string, proof: Uint8Array) =>
      client.json({ method: "POST", path: "/v1/login", json: { email, proof: encodeBase64url(proof) } }, isSession),
    ownerKey: (token: string) => client.json({ method: "GET", path: "/v1/owner/key", token }, isOwnerKeyMaterial),
    albums: (token: string) => client.json({ method: "GET", path: "/v1/albums", token }, isAlbumList),
    createAlbum: (token: string, b: NewAlbumBody) => {
      if (!UUID.test(b.id)) throw new TypeError("not a uuid");
      return client.json(
        {
          method: "POST",
          path: "/v1/albums",
          token,
          json: {
            id: b.id,
            title: encodeBase64url(b.title),
            wrapped_key: encodeBase64url(b.wrappedKey),
            wrap_nonce: encodeBase64url(b.wrapNonce),
          },
        },
        isCreated,
      );
    },
    // ── The owner's album (flows §3.4, §3.6, §3.7) ─────────────────────────

    /** §9.4. Every row, whatever its status. Writes no log. */
    album: (token: string, albumId: string) => client.json({ method: "GET", path: `/v1/albums/${assertUuid(albumId)}`, token }, isAlbumDetails),
    /** §9.5. `ready` rows only. An owner's fetch writes no log (§11.6). */
    metadata: (token: string, albumId: string) =>
      client.json({ method: "GET", path: `/v1/albums/${assertUuid(albumId)}/metadata`, token }, isAlbumMetadata),
    /** §11.3. Never logs. */
    thumbnail: async (token: string, mediaId: string) =>
      bytes(await client.request({ method: "GET", path: `/v1/media/${assertUuid(mediaId)}/thumbnail`, token })),
    /** §11.2, whole object from byte 0. Called only when the viewer shows this photo. */
    asset: async (token: string, mediaId: string) =>
      bytes(await client.request({ method: "GET", path: `/v1/media/${assertUuid(mediaId)}/asset`, token, range: "bytes=0-" })),
    /** §9.6. The id is the client's and the envelope's `asset_id`; the metadata envelope is ciphertext. */
    createMedia: (token: string, albumId: string, mediaId: string, metadata: Uint8Array) =>
      client.json(
        {
          method: "POST",
          path: `/v1/albums/${assertUuid(albumId)}/media`,
          token,
          json: { id: assertUuid(mediaId), kind: "photo", metadata: encodeBase64url(metadata) },
        },
        isCreatedMedia,
      ),
    /**
     * §9.7. `application/octet-stream`, set by the client for a byte body;
     * the browser sets `Content-Length` from the array, which fetch cannot
     * stream without it, so the 411 path is unreachable from here.
     */
    upload: (token: string, mediaId: string, variant: "asset" | "thumbnail", envelope: Uint8Array<ArrayBuffer>) =>
      client.json({ method: "PUT", path: `/v1/media/${assertUuid(mediaId)}/${variant}`, token, body: envelope }, isMediaStatus),
    /** §9.8. */
    mediaStatus: (token: string, mediaId: string) => client.json({ method: "GET", path: `/v1/media/${assertUuid(mediaId)}`, token }, isMediaStatus),
    /** §9.11. `204` erased, `202` hidden with erasure pending. A `404` arrives as an ApiFailure. */
    removeMedia: async (token: string, mediaId: string): Promise<"erased" | "pending"> => {
      const res = await client.request({ method: "DELETE", path: `/v1/media/${assertUuid(mediaId)}`, token });
      if (res.status === 204) return "erased";
      if (res.status === 202) return "pending";
      throw new UnexpectedResponse(res.status);
    },
    /** §11.7's summary: every recipient, revoked ones included. Labels arrive as ciphertext. */
    accessLog: (token: string, albumId: string) =>
      client.json({ method: "GET", path: `/v1/albums/${assertUuid(albumId)}/access-log`, token }, isAccessLog),
    /** §11.7's entries, newest first, paged by `before`. Both filters are identifiers, not credentials. */
    accessLogEntries: (token: string, albumId: string, page: { readonly recipientId?: string; readonly before?: number } = {}) => {
      const query: Record<string, string> = {};
      if (page.recipientId !== undefined) query["recipient_id"] = assertUuid(page.recipientId);
      if (page.before !== undefined) {
        if (!Number.isSafeInteger(page.before) || page.before < 0) throw new TypeError("not a cursor");
        query["before"] = String(page.before);
      }
      return client.json({ method: "GET", path: `/v1/albums/${assertUuid(albumId)}/access-log/entries`, token, query }, isAccessLogPage);
    },

    // ── Invites (flows §3.8, §3.9) ─────────────────────────────────────────

    /**
     * §7.7. The token is never here: only its hash. The id is the client's,
     * because it is in the wrap AAD. A `409` arrives as an ApiFailure and the
     * caller regenerates everything (flows §3.8).
     */
    createRecipient: (token: string, albumId: string, b: NewRecipientBody) =>
      client.json(
        {
          method: "POST",
          path: `/v1/albums/${assertUuid(albumId)}/recipients`,
          token,
          json: {
            id: assertUuid(b.id),
            kind: b.kind,
            label: encodeBase64url(b.label),
            token_hash: encodeBase64url(b.tokenHash),
            wrapped: encodeBase64url(b.wrapped),
            wrap_nonce: encodeBase64url(b.wrapNonce),
            ...(b.kind === "passphrase"
              ? {
                  kdf_salt: encodeBase64url(b.kdfSalt),
                  kdf_memory_kib: b.params.memoryKib,
                  kdf_iterations: b.params.iterations,
                  kdf_parallelism: b.params.parallelism,
                }
              : {}),
          },
        },
        isCreated,
      ),
    /** §7.8. No body, so no Content-Type. Idempotent: a repeat answers the original `revoked_at`. */
    revokeRecipient: (token: string, recipientId: string) =>
      client.json({ method: "POST", path: `/v1/recipients/${assertUuid(recipientId)}/revoke`, token }, isRevoked),

    /** No body, so no Content-Type: a JSON Content-Type with no body is a 400 (api-sketch §7.5). */
    logout: async (token: string): Promise<void> => {
      await client.request({ method: "POST", path: "/v1/logout", token });
    },
    logoutAll: async (token: string): Promise<void> => {
      await client.request({ method: "POST", path: "/v1/logout/all", token });
    },
  };
}
