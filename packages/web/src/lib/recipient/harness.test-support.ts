/*
 * Test support for the recipient path: a recording fake relay behind the real
 * API client, a fake envelope behind the real poison guard, and table-driven
 * fakes of the owner's three functions. No fake here parses, derives, wraps or
 * unwraps anything: the invite "parser" is a lookup table, the passphrase
 * "unwrap" is a comparison against one fixed passphrase, and the invite
 * "unwrap" returns whatever outcome the test asked for.
 */
import { createApiClient } from "$lib/api/client";
import { guard, type Envelope } from "$lib/envelope";
import { uuidToBytes } from "$lib/ids";
import type { Invite, ParseResult } from "$lib/invite/types";
import type {
  AlbumKey,
  InviteKeyMaterial,
  OpenInviteError,
  OpenInviteResult,
  OpenPassphraseResult,
  PassphraseKeyMaterial,
  UnwrapError,
} from "$lib/keys/types";
import { encodeBase64url } from "@vitrina/shared";
import { RecipientSession, type Deps, type State } from "./session";
import type { Picture } from "./render";

export const ORIGIN = "https://api.vitrina.test";
export const ALBUM_ID = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
export const RECIPIENT_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
export const TOKEN = encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => 200 - i));
/** K_invite as the fragment carries it (encryption spec §6.1). Its every spelling is searched for in what was sent. */
export const INVITE_KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff);
export const INVITE_KEY_B64 = encodeBase64url(INVITE_KEY);
export const PASSPHRASE_WORDS = ["tortilla", "de", "patatas", "con", "cebolla"];
export const PASSPHRASE = PASSPHRASE_WORDS.join(" ");

export const QR_FRAGMENT = `#v=1&a=${encodeBase64url(uuidToBytes(ALBUM_ID))}&t=${TOKEN}&k=${INVITE_KEY_B64}`;
export const PASS_FRAGMENT = `#v=1&a=${encodeBase64url(uuidToBytes(ALBUM_ID))}&t=${TOKEN}`;

export const media = (n: number, status = "ready") => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  kind: "photo",
  status,
  created_at: "2026-10-01T00:00:00Z",
});

// ── Fake ciphertext: a marker byte, then the plaintext. ───────────────────

const MARK = 0xc7;
export const seal = (plain: Uint8Array | string): Uint8Array => {
  const p = typeof plain === "string" ? new TextEncoder().encode(plain) : plain;
  return Uint8Array.from([MARK, ...p]);
};
const open = (ct: Uint8Array): Uint8Array<ArrayBuffer> => {
  if (ct[0] !== MARK) throw Object.assign(new Error("authentication failed"), { name: "EnvelopeError", code: "AuthenticationFailed" });
  return Uint8Array.from(ct.subarray(1));
};

export class FakeKey {
  __wbg_ptr = 1;
  freed = 0;
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
    if (!(key instanceof FakeKey) || key.freed > 0) throw new Error("null pointer passed to rust");
  };
  const module = {
    decryptRecipientLabel: (key: unknown, _id: Uint8Array, blob: Uint8Array) => (check("decryptRecipientLabel", key), new TextDecoder().decode(open(blob))),
    decryptAlbumTitle: (key: unknown, _id: Uint8Array, blob: Uint8Array) => (check("decryptAlbumTitle", key), new TextDecoder().decode(open(blob))),
    decryptMeta: (key: unknown, _id: Uint8Array, object: Uint8Array) => (check("decryptMeta", key), open(object)),
    decryptThumb: (key: unknown, _id: Uint8Array, object: Uint8Array) => (check("decryptThumb", key), open(object)),
    decryptAsset: (key: unknown, _id: Uint8Array, object: Uint8Array) => (check("decryptAsset", key), open(object)),
  };
  const { envelope, poison } = guard(module);
  return { envelope: envelope as unknown as Envelope, poison, calls, trapOn };
}

// ── The fake relay, behind the real API client ────────────────────────────

export type Sent = { url: string; method: string; headers: Record<string, string>; body: string };
type Reply = { status: number; json?: unknown; bytes?: Uint8Array; headers?: Record<string, string> } | "network";

export function relay() {
  const sent: Sent[] = [];
  const events: string[] = [];
  const album = {
    title: "Verano 2026",
    label: "María",
    kind: "qr" as "qr" | "passphrase",
    albumIdInRow: ALBUM_ID,
    media: [media(1), media(2), media(3)] as ReturnType<typeof media>[],
    /** Per-media metadata JSON; absent means {"width":1600,"height":1200}. */
    meta: new Map<string, string>(),
  };
  /** Per-path overrides, consumed in order; a path with none answers normally. */
  const overrides = new Map<string, Reply[]>();
  const override = (path: string, ...replies: Reply[]) => overrides.set(path, [...(overrides.get(path) ?? []), ...replies]);

  const err = (status: number, code: string, headers: Record<string, string> = {}): Reply => ({ status, json: { code, message: "x" }, headers });

  function answer(path: string): Reply {
    const queued = overrides.get(path);
    if (queued !== undefined && queued.length > 0) return queued.shift() as Reply;
    if (path === "/v1/recipient")
      return { status: 200, json: { id: RECIPIENT_ID, album_id: album.albumIdInRow, label: encodeBase64url(seal(album.label)), kind: album.kind, created_at: "2026-10-01T00:00:00Z" } };
    // §10.1, both kinds since 006: the row's kind, and the KDF fields for passphrase only.
    if (path === "/v1/recipient/key")
      return album.kind === "qr"
        ? { status: 200, json: { id: RECIPIENT_ID, kind: "qr", wrapped: "w".repeat(64), wrap_nonce: "n".repeat(32) } }
        : { status: 200, json: { id: RECIPIENT_ID, kind: "passphrase", kdf_salt: "s".repeat(22), wrapped: "w".repeat(64), wrap_nonce: "n".repeat(32), kdf_memory_kib: 65536, kdf_iterations: 3, kdf_parallelism: 1 } };
    if (path === `/v1/albums/${ALBUM_ID}`)
      return { status: 200, json: { id: ALBUM_ID, title: encodeBase64url(seal(album.title)), created_at: "2026-10-01T00:00:00Z", media: album.media } };
    if (path === `/v1/albums/${ALBUM_ID}/metadata`)
      return {
        status: 200,
        json: { metadata: album.media.filter((m) => m.status === "ready").map((m) => ({ media_id: m.id, envelope: encodeBase64url(seal(album.meta.get(m.id) ?? JSON.stringify({ width: 1600, height: 1200 }))) })) },
      };
    const thumb = /^\/v1\/media\/([0-9a-f-]{36})\/thumbnail$/.exec(path);
    if (thumb) return album.media.some((m) => m.id === thumb[1] && m.status === "ready") ? { status: 200, bytes: seal(`thumb ${thumb[1]}`) } : err(404, "NOT_FOUND");
    const asset = /^\/v1\/media\/([0-9a-f-]{36})\/asset$/.exec(path);
    if (asset) return album.media.some((m) => m.id === asset[1] && m.status === "ready") ? { status: 206, bytes: seal(`asset ${asset[1]}`) } : err(404, "NOT_FOUND");
    return err(404, "NOT_FOUND");
  }

  const fetchImpl = (async (input: string, init: RequestInit) => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: input, method: init.method ?? "GET", headers, body: typeof init.body === "string" ? init.body : init.body === undefined ? "" : String(init.body) });
    events.push(`request ${url.pathname}`);
    const r = answer(url.pathname);
    if (r === "network") throw new TypeError("Failed to fetch");
    const h = new Headers(r.headers);
    if (r.bytes !== undefined) return new Response(r.bytes as Uint8Array<ArrayBuffer>, { status: r.status, headers: h });
    h.set("content-type", "application/json");
    return new Response(JSON.stringify(r.json), { status: r.status, headers: h });
  }) as unknown as typeof fetch;

  return { sent, events, album, override, err, client: createApiClient(ORIGIN, fetchImpl) };
}

// ── Pictures and the owner's functions ────────────────────────────────────

export class FakePicture implements Picture {
  closed = 0;
  constructor(
    readonly source: string,
    readonly width = 1600,
    readonly height = 1200,
  ) {}
  close(): void {
    this.closed++;
  }
}

export function harness(opts: { fragment?: string; unwrap?: UnwrapError | "ok"; inviteOpen?: OpenInviteError | "ok"; invite?: Invite } = {}) {
  const r = relay();
  const env = fakeEnvelope();
  const pictures: FakePicture[] = [];
  const sleeps: number[] = [];
  const keys: FakeKey[] = [];
  const zeroedAt: Uint8Array[] = [];
  const opened: { passphrase: string; material: PassphraseKeyMaterial }[] = [];
  /** Each openInviteKey call: a copy of the bytes it was handed, before it zeroed them. */
  const invitesOpened: { inviteKey: number[]; material: InviteKeyMaterial }[] = [];
  let forgotten = 0;
  let framesAwaited = 0;

  const table = new Map<string, ParseResult>([
    [QR_FRAGMENT, { ok: true, invite: opts.invite ?? { mode: "qr", albumId: uuidToBytes(ALBUM_ID), token: TOKEN, inviteKey: Uint8Array.from(INVITE_KEY) } }],
    [PASS_FRAGMENT, { ok: true, invite: { mode: "passphrase", albumId: uuidToBytes(ALBUM_ID), token: TOKEN } }],
    ["#v=2&x=y", { ok: false, error: { kind: "unsupported-version" } }],
    ["#v=1&a=nope", { ok: false, error: { kind: "malformed" } }],
  ]);
  const parsed: string[] = [];

  const deps: Deps = {
    client: r.client,
    envelope: env.envelope,
    poison: env.poison,
    parseInvite: (f) => {
      parsed.push(f);
      r.events.push("parse");
      return table.get(f) ?? { ok: false, error: { kind: "missing" } };
    },
    // As the real one: zeroes the bytes on every path, success or failure.
    openInviteKey: (_env, inviteKey, material): OpenInviteResult => {
      invitesOpened.push({ inviteKey: Array.from(inviteKey), material });
      inviteKey.fill(0);
      zeroedAt.push(inviteKey);
      const outcome = opts.inviteOpen ?? "ok";
      if (outcome !== "ok") return { ok: false, error: outcome };
      const k = new FakeKey();
      keys.push(k);
      return { ok: true, albumKey: k as unknown as AlbumKey };
    },
    openPassphraseKey: async (_env, passphrase, material): Promise<OpenPassphraseResult> => {
      opened.push({ passphrase, material });
      const outcome = opts.unwrap ?? "ok";
      if (outcome !== "ok") return { ok: false, error: outcome };
      if (passphrase !== PASSPHRASE) return { ok: false, error: "wrong-passphrase" };
      const k = new FakeKey();
      keys.push(k);
      return { ok: true, albumKey: k as unknown as AlbumKey };
    },
    decodeImage: async (bytes) => {
      const p = new FakePicture(new TextDecoder().decode(bytes));
      pictures.push(p);
      return p;
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    nextFrames: async () => {
      framesAwaited++;
    },
    now: () => new Date("2026-08-06T12:00:00Z"),
    forgetInvite: () => {
      forgotten++;
    },
  };

  const session = new RecipientSession(deps);
  const states: State[] = [];
  session.subscribe((s) => states.push(s));

  return {
    ...r,
    env,
    session,
    states,
    pictures,
    sleeps,
    keys,
    zeroedAt,
    opened,
    invitesOpened,
    forgotten: () => forgotten,
    parsed,
    framesAwaited: () => framesAwaited,
    screen: () => session.current.screen,
  };
}

/** Let every queued promise settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

export const paths = (sent: readonly Sent[]) => sent.map((s) => new URL(s.url).pathname);

/** An in-memory stand-in for lib/session/recipient-session.ts's store. */
export function memoryStore(initial: string | null = null) {
  let value = initial;
  const writes: string[] = [];
  return {
    writes,
    value: () => value,
    read: () => value,
    write: (fragment: string) => {
      writes.push(fragment);
      value = fragment;
    },
    clear: () => {
      value = null;
    },
  };
}
