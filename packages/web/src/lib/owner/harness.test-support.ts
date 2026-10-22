/*
 * Test support for the owner path: a recording fake relay behind the real API
 * client, a fake envelope behind the real poison guard, the real session store
 * over a recording Storage, and table-driven fakes of the owner's eight key
 * functions. No fake here derives, wraps or unwraps anything. "Derivation" is
 * a comparison against one fixed password, and every "key" is an opaque
 * counted handle.
 */
import { createApiClient } from "$lib/api/client";
import { guard, type Envelope } from "$lib/envelope";
import type {
  AlbumKey,
  CreateAccountKeysError,
  DeriveLoginCredentialError,
  MasterKey,
  OpenAlbumKeyError,
  OpenMasterKeyError,
  OwnerKek,
  OwnerKeyFunctions,
  UnlockMasterKeyError,
  Wordlist,
} from "$lib/keys/owner-types";
import { sessionStore } from "$lib/session/owner-session";
import { uuidToBytes } from "$lib/ids";
import { encodeBase64url, OWNER_KDF_V1, RECIPIENT_KDF_V1 } from "@vitrina/shared";
import { fakeJpeg } from "./jpeg.test-support";
import type { Dims, Imaging } from "./prepare";
import { OwnerSession, type Deps, type State } from "./session";

export const ORIGIN = "https://api.vitrina.test";
/** The page's origin: where an invite link points (invite spec §1). Not the API's. */
export const APP_ORIGIN = "https://vitrina.test";
export const EMAIL = "  María.Pérez@Example.ES ";
export const PASSWORD = "a long chosen phrase";
export const TOKEN = encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => 100 + i));
export const TOKEN_2 = encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => 150 + i));
export const EXPIRES = "2026-10-29T12:00:00Z";
export const NOW = new Date("2026-10-15T12:00:00Z");
/** What the fake derivation yields for PASSWORD. Its every spelling is searched for in what was sent. */
export const PROOF = Uint8Array.from({ length: 32 }, (_, i) => (i * 11 + 5) & 0xff);
export const PROOF_B64 = encodeBase64url(PROOF);
export const ALBUM_A = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
export const ALBUM_B = "7a2d3b9f-4c5e-4f60-9bac-1d2e3f4a5b6c";
export const ALBUM_C = "8b3e4cab-5d6f-4071-8cbd-2e3f4a5b6c7d";
export const NEW_ALBUM = "9c4f5dbc-6e70-4182-9dce-3f4a5b6c7d8e";

// ── Fake ciphertext: a marker byte, then the plaintext. ───────────────────

const MARK = 0xc7;
export const seal = (plain: string): Uint8Array => Uint8Array.from([MARK, ...new TextEncoder().encode(plain)]);
const open = (ct: Uint8Array): string => {
  if (ct[0] !== MARK) throw Object.assign(new Error("authentication failed"), { name: "EnvelopeError", code: "AuthenticationFailed" });
  return new TextDecoder().decode(ct.subarray(1));
};
/** A title blob long enough for the 41-byte floor. */
export const titleBlob = (title: string): string => encodeBase64url(Uint8Array.from([...seal(title), ...new Uint8Array(40)]));
const trimPadding = (s: string): string => s.replace(/\u0000+$/, "");

const KINDS: Record<number, string> = { 1: "Asset", 2: "Thumb", 3: "Meta" };

/** What the fake envelope holds inside a sealed object: the plaintext after the kind byte and the id. */
export const unsealed = (ct: Uint8Array): Uint8Array => ct.slice(18);

export class FakeHandle {
  __wbg_ptr = 1;
  freed = 0;
  constructor(
    readonly kind: "master" | "kek" | "album",
    readonly label = "",
  ) {}
  free(): void {
    this.freed++;
  }
}

export function fakeEnvelope() {
  const calls: string[] = [];
  const trapOn = new Set<string>();
  /** Every plaintext handed to an encrypt call, by reference, so a test can see it was zeroed afterwards. */
  const plaintexts: Uint8Array[] = [];
  const check = (name: string, key: unknown) => {
    calls.push(name);
    if (trapOn.has(name)) throw new WebAssembly.RuntimeError("unreachable");
    if (!(key instanceof FakeHandle) || key.freed > 0) throw new Error("null pointer passed to rust");
  };
  // Asset, thumbnail and metadata envelopes: a kind byte, the 16-byte id, then the plaintext.
  // Opening checks both, so a thumbnail opened as an asset, or under another id, fails.
  const sealObject = (kind: number) => (key: unknown, id: Uint8Array, plain: Uint8Array) => {
    check(`encrypt${KINDS[kind]}`, key);
    plaintexts.push(plain);
    return Uint8Array.from([MARK, kind, ...id, ...plain]);
  };
  const openObject = (kind: number) => (key: unknown, id: Uint8Array, ct: Uint8Array) => {
    check(`decrypt${KINDS[kind]}`, key);
    if (ct[0] !== MARK || ct[1] !== kind || id.some((b, i) => ct[2 + i] !== b)) {
      throw Object.assign(new Error("authentication failed"), { name: "EnvelopeError", code: "AuthenticationFailed" });
    }
    return ct.slice(18);
  };
  const module = {
    encryptAsset: sealObject(1),
    encryptThumb: sealObject(2),
    encryptMeta: sealObject(3),
    decryptAsset: openObject(1),
    decryptThumb: openObject(2),
    decryptMeta: openObject(3),
    decryptAlbumTitle: (key: unknown, _id: Uint8Array, blob: Uint8Array) => (check("decryptAlbumTitle", key), trimPadding(open(blob))),
    encryptAlbumTitle: (key: unknown, _id: Uint8Array, title: string) => (check("encryptAlbumTitle", key), Uint8Array.from([...seal(title), ...new Uint8Array(40)])),
    // Labels: marker, the 16-byte recipient id, the label, padded past the 41-byte floor. Opening checks the id,
    // so a label encrypted under one attempt's id does not open under another's.
    encryptRecipientLabel: (key: unknown, id: Uint8Array, label: string) => {
      check("encryptRecipientLabel", key);
      return Uint8Array.from([MARK, ...id, ...new TextEncoder().encode(label), ...new Uint8Array(40)]);
    },
    decryptRecipientLabel: (key: unknown, id: Uint8Array, blob: Uint8Array) => {
      check("decryptRecipientLabel", key);
      if (blob[0] !== MARK || id.some((b, i) => blob[1 + i] !== b)) {
        throw Object.assign(new Error("authentication failed"), { name: "EnvelopeError", code: "AuthenticationFailed" });
      }
      return trimPadding(new TextDecoder().decode(blob.subarray(17)));
    },
  };
  const { envelope, poison } = guard(module);
  return { envelope: envelope as unknown as Envelope, poison, calls, trapOn, plaintexts };
}

// ── The fake relay, behind the real API client ────────────────────────────

export type Sent = { url: string; method: string; headers: Record<string, string>; body: string; bytes: Uint8Array | null };
export type Reply = { status: number; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | "network";

export type MediaFixture = {
  id: string;
  album: string;
  status: "pending" | "processing" | "ready" | "failed";
  created_at: string;
  updated_at: string;
  metadata: string;
  asset: Uint8Array | null;
  thumbnail: Uint8Array | null;
};

export type RecipientLogFixture = { recipient_id: string; last_opened_at: string | null };

/** A recipient row as the fake relay keeps it: what was posted, plus the summary's counts. */
export type RecipientFixture = {
  id: string;
  album: string;
  body: Record<string, unknown>;
  label: string;
  revoked_at: string | null;
  album_opens: number;
  media_opened: number;
  last_opened_at: string | null;
};

export type EntryFixture = { id: number; recipient_id: string; media_id: string | null; event: "album_opened" | "asset_viewed"; occurred_at: string };

/** A label blob as the fake envelope makes it, for seeding the relay. */
export const labelBlob = (recipientId: string, label: string): string =>
  encodeBase64url(Uint8Array.from([MARK, ...uuidToBytes(recipientId), ...new TextEncoder().encode(label), ...new Uint8Array(40)]));

export type AlbumFixture = { id: string; title: string; wrapped_key: string; wrap_nonce: string; media_count: number; created_at: string };

export const albumRow = (id: string, title: string, media = 0): AlbumFixture => ({
  id,
  title: titleBlob(title),
  wrapped_key: "w".repeat(64),
  wrap_nonce: "n".repeat(32),
  media_count: media,
  created_at: "2026-10-01T00:00:00Z",
});

export const ownerKeyBody = {
  kdf_salt: "s".repeat(22),
  kdf_memory_kib: 65536,
  kdf_iterations: 3,
  kdf_parallelism: 1,
  wrapped_master: "m".repeat(64),
  wrap_nonce: "n".repeat(32),
};

export function relay() {
  const sent: Sent[] = [];
  const events: string[] = [];
  const albums: AlbumFixture[] = [albumRow(ALBUM_A, "Verano 2026", 12), albumRow(ALBUM_B, "Navidad", 3)];
  const overrides = new Map<string, Reply[]>();
  const override = (path: string, ...replies: Reply[]) => overrides.set(path, [...(overrides.get(path) ?? []), ...replies]);
  const err = (status: number, code: string, headers: Record<string, string> = {}): Reply => ({ status, json: { code, message: "x" }, headers });
  const created = new Set<string>();
  const media = new Map<string, MediaFixture>();
  const accessLog: RecipientLogFixture[] = [];
  const recipients = new Map<string, RecipientFixture>();
  const entries: EntryFixture[] = [];
  let pageSize = 100;
  /** id → how many more status reports say `processing` for a row that is in fact complete. */
  const delayReady = new Map<string, number>();
  const reported = (m: MediaFixture) => {
    const n = delayReady.get(m.id) ?? 0;
    if (m.status !== "ready" || n === 0) return statusBody(m);
    delayReady.set(m.id, n - 1);
    return { ...statusBody(m), status: "processing", byte_size: null };
  };
  let clock = "2026-10-15T12:00:00Z";
  const statusBody = (m: MediaFixture) => ({
    id: m.id,
    album_id: m.album,
    kind: "photo",
    status: m.status,
    byte_size: m.status === "ready" ? (m.asset?.length ?? 0) + (m.thumbnail?.length ?? 0) : null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  });

  function mediaRoute(method: string, path: string, body: string, bytes: Uint8Array | null, query = ""): Reply | null {
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/albums\/([0-9a-f-]{36})$/.exec(path)) && method === "GET") {
      const id = m[1] as string;
      const a = albums.find((x) => x.id === id);
      if (a === undefined) return err(404, "NOT_FOUND");
      const rows = [...media.values()].filter((x) => x.album === id);
      return { status: 200, json: { id, title: a.title, created_at: a.created_at, media: rows.map((r) => ({ id: r.id, kind: "photo", status: r.status, created_at: r.created_at })) } };
    }
    if ((m = /^\/v1\/albums\/([0-9a-f-]{36})\/metadata$/.exec(path)) && method === "GET") {
      const rows = [...media.values()].filter((x) => x.album === m?.[1] && x.status === "ready");
      return { status: 200, json: { metadata: rows.map((r) => ({ media_id: r.id, envelope: r.metadata })) } };
    }
    if ((m = /^\/v1\/albums\/([0-9a-f-]{36})\/access-log$/.exec(path)) && method === "GET") {
      const id = m[1] as string;
      if (!albums.some((a) => a.id === id)) return err(404, "NOT_FOUND");
      const stored = [...recipients.values()]
        .filter((r) => r.album === id)
        .map((r) => ({ recipient_id: r.id, label: r.label, revoked_at: r.revoked_at, album_opens: r.album_opens, media_opened: r.media_opened, last_opened_at: r.last_opened_at }));
      return { status: 200, json: { recipients: [...accessLog.map((r) => ({ ...r, label: "x".repeat(60), revoked_at: null, album_opens: 1, media_opened: 0 })), ...stored] } };
    }
    if ((m = /^\/v1\/albums\/([0-9a-f-]{36})\/access-log\/entries$/.exec(path)) && method === "GET") {
      const id = m[1] as string;
      if (!albums.some((a) => a.id === id)) return err(404, "NOT_FOUND");
      const q = new URL(`https://x${query}`).searchParams;
      const before = q.get("before");
      const who = q.get("recipient_id");
      const rows = entries
        .filter((e) => (before === null || e.id < Number(before)) && (who === null || e.recipient_id === who))
        .sort((a, b) => b.id - a.id);
      const page = rows.slice(0, pageSize);
      return { status: 200, json: { entries: page, next_before: rows.length > pageSize ? (page[page.length - 1]?.id ?? null) : null } };
    }
    if ((m = /^\/v1\/albums\/([0-9a-f-]{36})\/recipients$/.exec(path)) && method === "POST") {
      const album = m[1] as string;
      if (!albums.some((a) => a.id === album)) return err(404, "NOT_FOUND");
      const b = JSON.parse(body) as Record<string, unknown>;
      const id = b["id"] as string;
      if (recipients.has(id) || [...recipients.values()].some((r) => r.body["token_hash"] === b["token_hash"])) return err(409, "CONFLICT");
      recipients.set(id, { id, album, body: b, label: b["label"] as string, revoked_at: null, album_opens: 0, media_opened: 0, last_opened_at: null });
      return { status: 201, json: { id, created_at: clock } };
    }
    if ((m = /^\/v1\/recipients\/([0-9a-f-]{36})\/revoke$/.exec(path)) && method === "POST") {
      const r = recipients.get(m[1] as string);
      if (r === undefined) return err(404, "NOT_FOUND");
      r.revoked_at ??= clock;
      return { status: 200, json: { revoked_at: r.revoked_at } };
    }
    if ((m = /^\/v1\/albums\/([0-9a-f-]{36})\/media$/.exec(path)) && method === "POST") {
      const b = JSON.parse(body) as { id: string; kind: string; metadata: string };
      if (media.has(b.id)) return err(409, "CONFLICT");
      const row: MediaFixture = { id: b.id, album: m[1] as string, status: "pending", created_at: clock, updated_at: clock, metadata: b.metadata, asset: null, thumbnail: null };
      media.set(b.id, row);
      return { status: 201, json: { id: b.id, status: "pending", created_at: clock } };
    }
    if ((m = /^\/v1\/media\/([0-9a-f-]{36})\/(asset|thumbnail)$/.exec(path))) {
      const row = media.get(m[1] as string);
      if (row === undefined) return err(404, "NOT_FOUND");
      const variant = m[2] as "asset" | "thumbnail";
      if (method === "GET") return row.status === "ready" && row[variant] !== null ? { status: 200, bytes: row[variant] as Uint8Array } : err(404, "NOT_FOUND");
      if (method !== "PUT") return null;
      if (row.status === "ready") return err(409, "CONFLICT");
      row[variant] = bytes;
      row.updated_at = clock;
      row.status = row.asset !== null && row.thumbnail !== null ? "ready" : "processing";
      return { status: 200, json: reported(row) };
    }
    if ((m = /^\/v1\/media\/([0-9a-f-]{36})$/.exec(path))) {
      const row = media.get(m[1] as string);
      if (row === undefined) return err(404, "NOT_FOUND");
      if (method === "GET") return { status: 200, json: reported(row) };
      if (method === "DELETE") {
        media.delete(row.id);
        return { status: 204 };
      }
    }
    return null;
  }

  function answer(method: string, path: string, body: string, bytes: Uint8Array | null, query = ""): Reply {
    const key = `${method} ${path}`;
    const queued = overrides.get(key);
    if (queued !== undefined && queued.length > 0) return queued.shift() as Reply;
    const routed = mediaRoute(method, path, body, bytes, query);
    if (routed !== null) return routed;
    switch (key) {
      case "POST /v1/signup":
        return { status: 201, json: { id: "11111111-1111-4111-8111-111111111111", created_at: "2026-10-15T12:00:00Z", token: TOKEN, expires_at: EXPIRES } };
      case "POST /v1/login/params":
        return { status: 200, json: { kdf_salt: "s".repeat(22), kdf_memory_kib: 65536, kdf_iterations: 3, kdf_parallelism: 1 } };
      case "POST /v1/login": {
        const b = JSON.parse(body) as { proof: string };
        return b.proof === PROOF_B64 ? { status: 200, json: { token: TOKEN_2, expires_at: EXPIRES } } : err(401, "INVALID_CREDENTIALS");
      }
      case "GET /v1/owner/key":
        return { status: 200, json: ownerKeyBody };
      case "GET /v1/albums":
        return { status: 200, json: { albums } };
      case "POST /v1/albums": {
        const b = JSON.parse(body) as { id: string };
        if (created.has(b.id)) return err(409, "CONFLICT");
        created.add(b.id);
        return { status: 201, json: { id: b.id, created_at: "2026-10-15T12:00:00Z" } };
      }
      case "POST /v1/logout":
      case "POST /v1/logout/all":
        return { status: 204 };
    }
    return err(404, "NOT_FOUND");
  }

  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? init.body : "";
    const bytes = init.body instanceof Uint8Array ? Uint8Array.from(init.body) : null;
    sent.push({ url: input, method, headers, body, bytes });
    events.push(`request ${method} ${url.pathname}`);
    const r = answer(method, url.pathname, body, bytes, url.search);
    if (r === "network") throw new TypeError("Failed to fetch");
    const h = new Headers(r.headers);
    if (r.status === 204 || r.status === 202) return new Response(null, { status: r.status, headers: h });
    if (r.bytes !== undefined) return new Response(Uint8Array.from(r.bytes), { status: r.status, headers: h });
    h.set("content-type", "application/json");
    return new Response(JSON.stringify(r.json), { status: r.status, headers: h });
  }) as unknown as typeof fetch;

  return {
    sent,
    events,
    albums,
    media,
    accessLog,
    recipients,
    entries,
    setPageSize: (n: number) => {
      pageSize = n;
    },
    delayReady,
    override,
    err,
    created,
    setClock: (t: string) => {
      clock = t;
    },
    client: createApiClient(ORIGIN, fetchImpl),
  };
}

// ── Storage: the real session store over a recording Storage ──────────────

export function recordingStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const writes: [string, string][] = [];
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      writes.push([k, v]);
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
  return { data, writes, storage };
}

// ── The owner's eight functions, faked ────────────────────────────────────

export type FakeKeyOptions = {
  /** The one password every fake accepts. */
  password?: string;
  createAccount?: CreateAccountKeysError;
  derive?: DeriveLoginCredentialError;
  openMaster?: OpenMasterKeyError;
  unlock?: Exclude<UnlockMasterKeyError, "wrong-password">;
  /** Album ids whose wrapping will not open, and how. */
  albumFails?: Map<string, OpenAlbumKeyError>;
  createAlbum?: "could-not-derive";
  /** How the invite functions fail, if they do. */
  invite?: "could-not-derive" | "unusable-wordlist";
};

/** What the fake invite functions handed out, in order: every id, token and K_invite a test may search for. */
export type IssuedInvite = { recipientId: string; token: string; tokenHash: Uint8Array; inviteKey: string | null; words: readonly string[] | null };

/** Recipient ids the fakes hand out, one per call. A 409 retry gets the next. */
export const RECIPIENT_IDS = [
  "d1000000-0000-4000-8000-000000000001",
  "d2000000-0000-4000-8000-000000000002",
  "d3000000-0000-4000-8000-000000000003",
  "d4000000-0000-4000-8000-000000000004",
] as const;

export function fakeKeys(opts: FakeKeyOptions, events: string[]) {
  const password = opts.password ?? PASSWORD;
  const handles: FakeHandle[] = [];
  const proofs: Uint8Array[] = [];
  const passwordsSeen: string[] = [];
  const issued: IssuedInvite[] = [];
  const wordlistsSeen: string[] = [];
  /** A fresh, distinct value per call. Not random and not a hash: opaque bytes a test can recognise. */
  const issue = (kind: "qr" | "passphrase", words: readonly string[] | null) => {
    const n = issued.length;
    const recipientId = RECIPIENT_IDS[n] ?? `d9000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const token = encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => (n * 37 + i * 3 + 1) & 0xff));
    const tokenHash = Uint8Array.from({ length: 32 }, (_, i) => (n * 53 + i * 5 + 2) & 0xff);
    const inviteKey = kind === "qr" ? encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => (n * 71 + i * 7 + 3) & 0xff)) : null;
    const inv = { recipientId, token, tokenHash, inviteKey, words };
    issued.push(inv);
    return inv;
  };
  const make = (kind: FakeHandle["kind"], label = "") => {
    const h = new FakeHandle(kind, label);
    handles.push(h);
    return h;
  };

  const keys: OwnerKeyFunctions = {
    createAccountKeys: async (_env, pw) => {
      events.push("createAccountKeys");
      passwordsSeen.push(pw);
      if (opts.createAccount !== undefined) return { ok: false, error: opts.createAccount };
      const proof = Uint8Array.from(PROOF);
      proofs.push(proof);
      return {
        ok: true,
        keys: {
          master: make("master") as unknown as MasterKey,
          proof,
          kdfSalt: new Uint8Array(16).fill(7),
          params: OWNER_KDF_V1,
          wrappedMaster: new Uint8Array(48).fill(8),
          wrapNonce: new Uint8Array(24).fill(9),
        },
      };
    },
    deriveLoginCredential: async (_env, pw) => {
      events.push("deriveLoginCredential");
      passwordsSeen.push(pw);
      if (opts.derive !== undefined) return { ok: false, error: opts.derive };
      // A wrong password derives a different proof, which the relay refuses.
      const proof = pw === password ? Uint8Array.from(PROOF) : new Uint8Array(32).fill(1);
      proofs.push(proof);
      return { ok: true, kek: make("kek") as unknown as OwnerKek, proof };
    },
    openMasterKey: (_env, kek) => {
      events.push("openMasterKey");
      (kek as unknown as FakeHandle).free(); // always, as the signature requires
      if (opts.openMaster !== undefined) return { ok: false, error: opts.openMaster };
      return { ok: true, master: make("master") as unknown as MasterKey };
    },
    unlockMasterKey: async (_env, pw) => {
      events.push("unlockMasterKey");
      passwordsSeen.push(pw);
      if (opts.unlock !== undefined) return { ok: false, error: opts.unlock };
      if (pw === "") return { ok: false, error: "empty" };
      if (pw !== password) return { ok: false, error: "wrong-password" };
      return { ok: true, master: make("master") as unknown as MasterKey };
    },
    openAlbumKey: (_env, master, album) => {
      events.push(`openAlbumKey ${album.id}`);
      if ((master as unknown as FakeHandle).freed > 0) throw new Error("used a freed master");
      const fail = opts.albumFails?.get(album.id);
      if (fail !== undefined) return { ok: false, error: fail };
      return { ok: true, albumKey: make("album", album.id) as unknown as AlbumKey };
    },
    createAlbumKey: (_env, _master, albumId) => {
      events.push(`createAlbumKey ${albumId}`);
      if (opts.createAlbum !== undefined) return { ok: false, error: opts.createAlbum };
      return { ok: true, albumKey: make("album", albumId) as unknown as AlbumKey, wrappedKey: new Uint8Array(48).fill(3), wrapNonce: new Uint8Array(24).fill(4) };
    },
    createQrInvite: async (_env, albumKey) => {
      events.push("createQrInvite");
      if ((albumKey as unknown as FakeHandle).freed > 0) throw new Error("used a freed album key");
      if (opts.invite !== undefined) return { ok: false, error: "could-not-derive" };
      const i = issue("qr", null);
      return {
        ok: true,
        invite: { kind: "qr", recipientId: i.recipientId, token: i.token, tokenHash: i.tokenHash, inviteKey: i.inviteKey as string, wrapped: new Uint8Array(48).fill(5), wrapNonce: new Uint8Array(24).fill(6) },
      };
    },
    createPassphraseInvite: async (_env, albumKey, wordlist) => {
      events.push(`createPassphraseInvite ${wordlist.language}`);
      wordlistsSeen.push(wordlist.language);
      if ((albumKey as unknown as FakeHandle).freed > 0) throw new Error("used a freed album key");
      if (opts.invite !== undefined) return { ok: false, error: opts.invite };
      const n = issued.length;
      const words = [0, 1, 2, 3, 4].map((k) => wordlist.words[(n * 5 + k) % wordlist.words.length] as string);
      const i = issue("passphrase", words);
      return {
        ok: true,
        invite: {
          kind: "passphrase",
          recipientId: i.recipientId,
          token: i.token,
          tokenHash: i.tokenHash,
          words,
          kdfSalt: new Uint8Array(16).fill(7),
          params: RECIPIENT_KDF_V1,
          wrapped: new Uint8Array(48).fill(8),
          wrapNonce: new Uint8Array(24).fill(9),
        },
      };
    },
  };
  return { keys, handles, proofs, passwordsSeen, issued, wordlistsSeen };
}

// ── The harness ───────────────────────────────────────────────────────────

export const MEDIA_IDS = ["a1000000-0000-4000-8000-000000000001", "a2000000-0000-4000-8000-000000000002", "a3000000-0000-4000-8000-000000000003"] as const;

export class FakePicture {
  closed = 0;
  readonly width = 100;
  readonly height = 75;
  constructor(readonly bytes: number) {}
  close(): void {
    this.closed++;
  }
}

/** An Imaging whose every JPEG is a clean, structurally valid stream of the size asked for. */
export function okImaging(oriented: Dims = { width: 4032, height: 3024 }): Imaging & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    decode: async (_f, r) => {
      log.push("decode");
      const d =
        r === null
          ? oriented
          : "width" in r
            ? { width: r.width, height: Math.round((oriented.height * r.width) / oriented.width) }
            : { width: Math.round((oriented.width * r.height) / oriented.height), height: r.height };
      return { ...d, close: () => void log.push("close") };
    },
    encode: async (_b, size) => (log.push(`encode ${size.width}x${size.height}`), new Blob([fakeJpeg(size.width, size.height)], { type: "image/jpeg" })),
  };
}

/** Two fake lists in two languages, neither English-only: nothing in the flow may assume a language. */
export const FAKE_WORDLISTS: readonly Wordlist[] = [
  { language: "en", words: ["acorn", "badge", "cabin", "dwell", "ember", "fable", "gravy", "hatch"] },
  { language: "es", words: ["árbol", "barco", "cielo", "dátil", "época", "faro", "gato", "hilo"] },
];

export function harness(
  opts: FakeKeyOptions & {
    stored?: Record<string, string>;
    blocklist?: string[];
    imaging?: Imaging | ((events: string[]) => Imaging);
    wordlists?: readonly Wordlist[] | "fail";
    displayLanguage?: string;
  } = {},
) {
  const r = relay();
  const env = fakeEnvelope();
  const k = fakeKeys(opts, r.events);
  const st = recordingStorage(opts.stored);
  const sleeps: number[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  let blocklistLoads = 0;
  let wordlistLoads = 0;
  let framesAwaited = 0;
  let now = NOW;
  const ids = [NEW_ALBUM, ALBUM_C];
  const mediaIds = [...MEDIA_IDS];
  const pictures: FakePicture[] = [];

  const deps: Deps = {
    client: r.client,
    envelope: env.envelope,
    poison: env.poison,
    keys: k.keys,
    store: sessionStore(() => st.storage),
    loadBlocklist: async () => {
      blocklistLoads++;
      r.events.push("loadBlocklist");
      return new Set(opts.blocklist ?? ["passwordpassword", "123456789012"]);
    },
    newAlbumId: () => ids.shift() ?? "00000000-0000-4000-8000-000000000000",
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    nextFrames: async () => {
      framesAwaited++;
      r.events.push("frames");
    },
    now: () => now,
    setTimer: (ms, fn) => {
      const t = { ms, fn, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    imaging: typeof opts.imaging === "function" ? opts.imaging(r.events) : (opts.imaging ?? okImaging()),
    decodeImage: async (bytes) => {
      if (bytes.length === 0 || bytes[0] === 0x00) throw new Error("not an image");
      const p = new FakePicture(bytes.length);
      pictures.push(p);
      return p;
    },
    newMediaId: () => mediaIds.shift() ?? "00000000-0000-4000-8000-0000000000ff",
    loadWordlists: async () => {
      wordlistLoads++;
      r.events.push("loadWordlists");
      if (opts.wordlists === "fail") throw new Error("chunk failed to load");
      return opts.wordlists ?? FAKE_WORDLISTS;
    },
    displayLanguage: opts.displayLanguage ?? "en",
    origin: APP_ORIGIN,
  };

  const session = new OwnerSession(deps);
  const states: State[] = [];
  session.subscribe((s) => states.push(s));

  return {
    ...r,
    ...k,
    env,
    storage: st,
    session,
    states,
    sleeps,
    timers,
    blocklistLoads: () => blocklistLoads,
    wordlistLoads: () => wordlistLoads,
    framesAwaited: () => framesAwaited,
    setNow: (d: Date) => {
      now = d;
    },
    pictures,
    screen: () => session.current.screen,
  };
}

export const STORED = { "vitrina:owner:token": TOKEN, "vitrina:owner:expires_at": EXPIRES };

/** Let every queued promise settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

export const routes = (sent: readonly Sent[]) => sent.map((s) => `${s.method} ${new URL(s.url).pathname}`);
