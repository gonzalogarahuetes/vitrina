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
import type { ApiClient } from "$lib/api/client";
import type { AlbumWrapping, LoginParams, OwnerKeyMaterial } from "$lib/keys/owner-types";
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
    /** No body, so no Content-Type: a JSON Content-Type with no body is a 400 (api-sketch §7.5). */
    logout: async (token: string): Promise<void> => {
      await client.request({ method: "POST", path: "/v1/logout", token });
    },
    logoutAll: async (token: string): Promise<void> => {
      await client.request({ method: "POST", path: "/v1/logout/all", token });
    },
  };
}
