/*
 * The fake relay the owner specs run against, moved here unchanged from
 * owner.spec.ts when the album got a spec of its own, plus the album routes.
 * It stores whatever the app posts and hands it back, so every envelope the
 * app opens was made by the app itself, with the real WASM. It cannot read
 * any of it: titles, metadata, assets and thumbnails are ciphertext here as
 * they are on the real relay.
 */
import { test, type BrowserContext, type Route } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { apiOrigin } from "./helpers.ts";

export type Logged = {
  method: string;
  path: string;
  search: string;
  hash: string;
  body: string;
  /** The raw body, for the binary PUTs. */
  bytes?: Buffer | null;
  headers: Record<string, string>;
};

type Media = {
  id: string;
  album: string;
  status: "pending" | "processing" | "ready" | "failed";
  created_at: string;
  updated_at: string;
  metadata: string;
  asset: Buffer | null;
  thumbnail: Buffer | null;
};

/** A relay that keeps what it is sent. Normalises the address as api-sketch §8.2 does. */
export function fakeRelay(opts: { expiresInMs: number }) {
  const norm = (e: string) => e.normalize("NFC").trim().toLowerCase();
  const accounts = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, { email: string; revoked: boolean }>();
  const albums = new Map<string, Record<string, unknown>[]>();
  const log: Logged[] = [];
  let holdOwnerKey: Promise<void> | null = null;
  /** "METHOD /path" → Retry-After seconds, refused once with a 429. */
  const refuse = new Map<string, number>();
  const media = new Map<string, Media>();
  const accessLog: { last_opened_at: string | null }[] = [];
  /** "METHOD /path" → what to do instead, once. */
  const once = new Map<string, "store-then-drop" | { status: number }>();
  /** While set, every row's status is reported as processing, however complete it is. */
  let holding = false;
  const now = () => new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const statusBody = (m: Media) => ({
    id: m.id,
    album_id: m.album,
    kind: "photo",
    status: m.status,
    byte_size: m.status === "ready" ? (m.asset?.length ?? 0) + (m.thumbnail?.length ?? 0) : null,
    created_at: m.created_at,
    updated_at: m.updated_at,
  });

  const mint = (email: string) => {
    const token = randomBytes(32).toString("base64url");
    tokens.set(token, { email, revoked: false });
    return { token, expires_at: new Date(Date.now() + opts.expiresInMs).toISOString().replace(/\.\d+Z$/, "Z") };
  };

  async function handle(route: Route, pageOrigin: string): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const headers = await req.allHeaders();
    const cors = {
      "access-control-allow-origin": pageOrigin,
      "access-control-allow-headers": "authorization, content-type, range",
      "access-control-allow-methods": "GET, POST, PUT, DELETE",
      "access-control-expose-headers": "retry-after",
      "cache-control": "no-store",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = req.postData() ?? "";
    const bytes = req.postDataBuffer();
    log.push({ method: req.method(), path: url.pathname, search: url.search, hash: url.hash, body, bytes, headers });

    const json = (status: number, value: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(value) });
    const error = (status: number, code: string) => json(status, { code, message: "x" });
    const caller = () => {
      const t = /^Bearer (.+)$/.exec(headers["authorization"] ?? "")?.[1];
      const row = t === undefined ? undefined : tokens.get(t);
      return row === undefined || row.revoked ? null : { token: t as string, ...row };
    };
    const key = `${req.method()} ${url.pathname}`;
    const retryAfter = refuse.get(key);
    if (retryAfter !== undefined) {
      refuse.delete(key);
      return route.fulfill({
        status: 429,
        headers: { ...cors, "content-type": "application/json", "retry-after": String(retryAfter) },
        body: JSON.stringify({ code: "RATE_LIMITED", message: "x" }),
      });
    }

    if (key === "POST /v1/signup") {
      const b = JSON.parse(body) as Record<string, unknown>;
      const email = norm(b["email"] as string);
      if (accounts.has(email)) return error(409, "CONFLICT");
      accounts.set(email, b);
      albums.set(email, []);
      return json(201, { id: randomBytes(16).toString("hex"), created_at: new Date().toISOString(), ...mint(email) });
    }
    if (key === "POST /v1/login/params") {
      const a = accounts.get(norm((JSON.parse(body) as { email: string }).email));
      const decoy = { kdf_salt: randomBytes(16).toString("base64url"), kdf_memory_kib: 65536, kdf_iterations: 3, kdf_parallelism: 1 };
      return json(200, a === undefined ? decoy : { kdf_salt: a["kdf_salt"], kdf_memory_kib: a["kdf_memory_kib"], kdf_iterations: a["kdf_iterations"], kdf_parallelism: a["kdf_parallelism"] });
    }
    if (key === "POST /v1/login") {
      const b = JSON.parse(body) as { email: string; proof: string };
      const email = norm(b.email);
      const a = accounts.get(email);
      if (a === undefined || a["proof"] !== b.proof) return error(401, "INVALID_CREDENTIALS");
      return json(200, mint(email));
    }
    const who = caller();
    if (who === null) return error(401, "UNAUTHENTICATED");
    const a = accounts.get(who.email) as Record<string, unknown>;

    // ── The album routes (api-sketch §9.4–§9.8, §9.11, §11.2, §11.3, §11.7) ──
    const instead = once.get(key);
    if (instead !== undefined) once.delete(key);
    const ownAlbum = (id: string) => (albums.get(who.email) ?? []).find((x) => x["id"] === id);
    let m: RegExpExecArray | null;
    if ((m = /^\/v1\/albums\/([0-9a-f-]{36})(\/metadata|\/media|\/access-log)?$/.exec(url.pathname))) {
      const album = ownAlbum(m[1] as string);
      if (album === undefined) return error(404, "NOT_FOUND");
      const rows = [...media.values()].filter((x) => x.album === m?.[1]);
      if (req.method() === "GET" && m[2] === undefined) {
        return json(200, { id: album["id"], title: album["title"], created_at: album["created_at"], media: rows.map((r) => ({ id: r.id, kind: "photo", status: r.status, created_at: r.created_at })) });
      }
      if (req.method() === "GET" && m[2] === "/metadata") return json(200, { metadata: rows.filter((r) => r.status === "ready").map((r) => ({ media_id: r.id, envelope: r.metadata })) });
      if (req.method() === "GET" && m[2] === "/access-log") return json(200, { recipients: accessLog });
      if (req.method() === "POST" && m[2] === "/media") {
        const b = JSON.parse(body) as { id: string; kind: string; metadata: string };
        if (media.has(b.id)) return error(409, "CONFLICT");
        const t = now();
        media.set(b.id, { id: b.id, album: m[1] as string, status: "pending", created_at: t, updated_at: t, metadata: b.metadata, asset: null, thumbnail: null });
        // A lost response: the row exists, the client never hears so.
        if (instead === "store-then-drop") return route.abort("connectionreset");
        return json(201, { id: b.id, status: "pending", created_at: t });
      }
    }
    if ((m = /^\/v1\/media\/([0-9a-f-]{36})(\/asset|\/thumbnail)?$/.exec(url.pathname))) {
      const row = media.get(m[1] as string);
      if (row === undefined || ownAlbum(row.album) === undefined) return error(404, "NOT_FOUND");
      const variant = m[2] === "/asset" ? "asset" : m[2] === "/thumbnail" ? "thumbnail" : null;
      if (variant !== null && req.method() === "GET") {
        const obj = row[variant];
        if (row.status !== "ready" || obj === null) return error(404, "NOT_FOUND");
        return route.fulfill({ status: variant === "asset" ? 206 : 200, headers: { ...cors, "content-type": "application/octet-stream" }, body: obj });
      }
      if (variant !== null && req.method() === "PUT") {
        if (headers["content-type"] !== "application/octet-stream") return error(415, "UNSUPPORTED_MEDIA_TYPE");
        if (row.status === "ready") return error(409, "CONFLICT");
        row[variant] = bytes;
        row.updated_at = now();
        row.status = row.asset !== null && row.thumbnail !== null ? "ready" : "processing";
        // Complete, but reported as processing until the test releases this row (api-sketch §9.7: a slow store).
        if (holding) return json(200, { ...statusBody(row), status: "processing", byte_size: null });
        return json(200, statusBody(row));
      }
      if (variant === null && req.method() === "GET") {
        if (holding) return json(200, { ...statusBody(row), status: row.status === "ready" ? "processing" : row.status, byte_size: null });
        return json(200, statusBody(row));
      }
      if (variant === null && req.method() === "DELETE") {
        if (typeof instead === "object") return route.fulfill({ status: instead.status, headers: cors });
        media.delete(row.id);
        return route.fulfill({ status: 204, headers: cors });
      }
    }
    switch (key) {
      case "GET /v1/owner/key":
        if (holdOwnerKey !== null) await holdOwnerKey;
        return json(200, {
          kdf_salt: a["kdf_salt"],
          kdf_memory_kib: a["kdf_memory_kib"],
          kdf_iterations: a["kdf_iterations"],
          kdf_parallelism: a["kdf_parallelism"],
          wrapped_master: a["wrapped_master"],
          wrap_nonce: a["wrap_nonce"],
        });
      case "GET /v1/albums":
        return json(200, { albums: [...(albums.get(who.email) ?? [])].reverse() });
      case "POST /v1/albums": {
        const b = JSON.parse(body) as Record<string, unknown>;
        const list = albums.get(who.email) ?? [];
        if (list.some((x) => x["id"] === b["id"])) return error(409, "CONFLICT");
        const created_at = new Date().toISOString();
        list.push({ ...b, created_at, media_count: 0 });
        return json(201, { id: b["id"], created_at });
      }
      case "POST /v1/logout":
        (tokens.get(who.token) as { revoked: boolean }).revoked = true;
        return route.fulfill({ status: 204, headers: cors });
      case "POST /v1/logout/all":
        for (const t of tokens.values()) if (t.email === who.email) t.revoked = true;
        return route.fulfill({ status: 204, headers: cors });
    }
    return error(404, "NOT_FOUND");
  }

  return {
    log,
    tokens,
    accounts,
    media,
    accessLog,
    /** The next request to `route` ("METHOD /path") is answered this way instead. */
    once(route: string, what: "store-then-drop" | { status: number }): void {
      once.set(route, what);
    },
    /** Every status report says processing until the returned function is called (api-sketch §9.7: a slow store). */
    holdReady(): () => void {
      holding = true;
      return () => {
        holding = false;
      };
    },
    /** The next request to `route` ("METHOD /path") gets a 429 with this Retry-After. */
    refuseNext(route: string, retryAfterSeconds: number): void {
      refuse.set(route, retryAfterSeconds);
    },
    /** Delays GET /v1/owner/key until the returned function is called. */
    hold(): () => void {
      let release!: () => void;
      holdOwnerKey = new Promise((r) => (release = r));
      return () => {
        holdOwnerKey = null;
        release();
      };
    },
    async attach(context: BrowserContext): Promise<void> {
      const base = test.info().project.use.baseURL as string;
      const origin = apiOrigin();
      await context.route((u) => u.origin === origin, (route) => handle(route, new URL(base).origin));
      // Anything else off-origin fails, as with no network.
      await context.route((u) => u.origin !== origin && u.origin !== new URL(base).origin, (route) => route.abort("internetdisconnected"));
    },
  };
}
