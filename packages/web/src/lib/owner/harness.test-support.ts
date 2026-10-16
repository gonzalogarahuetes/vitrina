/*
 * Test support for the owner path: a recording fake relay behind the real API
 * client, a fake envelope behind the real poison guard, the real session store
 * over a recording Storage, and table-driven fakes of the owner's six key
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
} from "$lib/keys/owner-types";
import { sessionStore } from "$lib/session/owner-session";
import { encodeBase64url, OWNER_KDF_V1 } from "@vitrina/shared";
import { OwnerSession, type Deps, type State } from "./session";

export const ORIGIN = "https://api.vitrina.test";
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
  const check = (name: string, key: unknown) => {
    calls.push(name);
    if (trapOn.has(name)) throw new WebAssembly.RuntimeError("unreachable");
    if (!(key instanceof FakeHandle) || key.freed > 0) throw new Error("null pointer passed to rust");
  };
  const module = {
    decryptAlbumTitle: (key: unknown, _id: Uint8Array, blob: Uint8Array) => (check("decryptAlbumTitle", key), trimPadding(open(blob))),
    encryptAlbumTitle: (key: unknown, _id: Uint8Array, title: string) => (check("encryptAlbumTitle", key), Uint8Array.from([...seal(title), ...new Uint8Array(40)])),
  };
  const { envelope, poison } = guard(module);
  return { envelope: envelope as unknown as Envelope, poison, calls, trapOn };
}

// ── The fake relay, behind the real API client ────────────────────────────

export type Sent = { url: string; method: string; headers: Record<string, string>; body: string };
export type Reply = { status: number; json?: unknown; headers?: Record<string, string> } | "network";

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

  function answer(method: string, path: string, body: string): Reply {
    const key = `${method} ${path}`;
    const queued = overrides.get(key);
    if (queued !== undefined && queued.length > 0) return queued.shift() as Reply;
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
    sent.push({ url: input, method, headers, body });
    events.push(`request ${method} ${url.pathname}`);
    const r = answer(method, url.pathname, body);
    if (r === "network") throw new TypeError("Failed to fetch");
    const h = new Headers(r.headers);
    if (r.status === 204) return new Response(null, { status: 204, headers: h });
    h.set("content-type", "application/json");
    return new Response(JSON.stringify(r.json), { status: r.status, headers: h });
  }) as unknown as typeof fetch;

  return { sent, events, albums, override, err, created, client: createApiClient(ORIGIN, fetchImpl) };
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

// ── The owner's six functions, faked ──────────────────────────────────────

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
};

export function fakeKeys(opts: FakeKeyOptions, events: string[]) {
  const password = opts.password ?? PASSWORD;
  const handles: FakeHandle[] = [];
  const proofs: Uint8Array[] = [];
  const passwordsSeen: string[] = [];
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
  };
  return { keys, handles, proofs, passwordsSeen };
}

// ── The harness ───────────────────────────────────────────────────────────

export function harness(opts: FakeKeyOptions & { stored?: Record<string, string>; blocklist?: string[] } = {}) {
  const r = relay();
  const env = fakeEnvelope();
  const k = fakeKeys(opts, r.events);
  const st = recordingStorage(opts.stored);
  const sleeps: number[] = [];
  const timers: { ms: number; fn: () => void; cancelled: boolean }[] = [];
  let blocklistLoads = 0;
  let framesAwaited = 0;
  let now = NOW;
  const ids = [NEW_ALBUM, ALBUM_C];

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
    framesAwaited: () => framesAwaited,
    setNow: (d: Date) => {
      now = d;
    },
    screen: () => session.current.screen,
  };
}

export const STORED = { "vitrina:owner:token": TOKEN, "vitrina:owner:expires_at": EXPIRES };

/** Let every queued promise settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
}

export const routes = (sent: readonly Sent[]) => sent.map((s) => `${s.method} ${new URL(s.url).pathname}`);
