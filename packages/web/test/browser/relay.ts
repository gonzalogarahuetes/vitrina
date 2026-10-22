/*
 * The fake relay the owner specs run against, moved here unchanged from
 * owner.spec.ts when the album got a spec of its own, plus the album routes,
 * and since the invite screens the recipient routes too: a recipient's bearer
 * token is hashed here as the real relay hashes it (schema §6) and looked up
 * by the token_hash the owner's client posted, so a link the owner's page
 * made opens the album in another browser context exactly when the client
 * got every half of it right.
 * It stores whatever the app posts and hands it back, so every envelope the
 * app opens was made by the app itself, with the real WASM. It cannot read
 * any of it: titles, metadata, assets and thumbnails are ciphertext here as
 * they are on the real relay.
 */
import { test, type BrowserContext, type Route } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";
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
  /** Recipient rows, as POST /v1/albums/{id}/recipients stored them: everything posted, nothing more. */
  const recipients = new Map<string, { album: string; body: Record<string, unknown>; created_at: string; revoked_at: string | null }>();
  /** access_log (api-sketch §11.6), written by the recipient routes that log. */
  const entries: { id: number; recipient_id: string; media_id: string | null; event: "album_opened" | "asset_viewed"; occurred_at: string }[] = [];
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

    // ── A recipient's bearer token (api-sketch §7.1): hashed over its 32 raw bytes, then looked up ──
    const bearer = /^Bearer (.+)$/.exec(headers["authorization"] ?? "")?.[1];
    if (bearer !== undefined && !tokens.has(bearer)) {
      const raw = Buffer.from(bearer, "base64url");
      const hash = raw.length === 32 && raw.toString("base64url") === bearer ? createHash("sha256").update(raw).digest("base64url") : null;
      const found = [...recipients.entries()].find(([, r]) => r.body["token_hash"] === hash);
      if (found === undefined) return error(401, "UNAUTHENTICATED");
      const [rid, r] = found;
      if (r.revoked_at !== null) return error(403, "ACCESS_REVOKED");
      const logRow = (event: "album_opened" | "asset_viewed", media_id: string | null) =>
        entries.push({ id: entries.length + 1, recipient_id: rid, media_id, event, occurred_at: now() });
      const rows = [...media.values()].filter((x) => x.album === r.album && x.status === "ready");
      let rm: RegExpExecArray | null;
      if (key === "GET /v1/recipient/key") {
        const b = r.body;
        const kdf = b["kind"] === "passphrase" ? { kdf_salt: b["kdf_salt"], kdf_memory_kib: b["kdf_memory_kib"], kdf_iterations: b["kdf_iterations"], kdf_parallelism: b["kdf_parallelism"] } : {};
        return json(200, { id: rid, kind: b["kind"], wrapped: b["wrapped"], wrap_nonce: b["wrap_nonce"], ...kdf });
      }
      if (key === "GET /v1/recipient") return json(200, { id: rid, album_id: r.album, label: r.body["label"], kind: r.body["kind"], created_at: r.created_at });
      if (key === `GET /v1/albums/${r.album}`) {
        const album = [...albums.values()].flat().find((x) => x["id"] === r.album) as Record<string, unknown>;
        return json(200, { id: r.album, title: album["title"], created_at: album["created_at"], media: rows.map((x) => ({ id: x.id, kind: "photo", status: x.status, created_at: x.created_at })) });
      }
      if (key === `GET /v1/albums/${r.album}/metadata`) {
        logRow("album_opened", null);
        return json(200, { metadata: rows.map((x) => ({ media_id: x.id, envelope: x.metadata })) });
      }
      if (req.method() === "GET" && (rm = /^\/v1\/media\/([0-9a-f-]{36})\/(asset|thumbnail)$/.exec(url.pathname))) {
        const row = rows.find((x) => x.id === rm?.[1]);
        if (row === undefined) return error(404, "NOT_FOUND");
        if (rm[2] === "thumbnail") return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/octet-stream" }, body: row.thumbnail as Buffer });
        if (!/^bytes=0-/.test(headers["range"] ?? "")) return error(416, "RANGE_NOT_SATISFIABLE");
        logRow("asset_viewed", row.id);
        return route.fulfill({ status: 206, headers: { ...cors, "content-type": "application/octet-stream" }, body: row.asset as Buffer });
      }
      return error(404, "NOT_FOUND");
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
    if ((m = /^\/v1\/albums\/([0-9a-f-]{36})(\/metadata|\/media|\/access-log|\/access-log\/entries|\/recipients)?$/.exec(url.pathname))) {
      const album = ownAlbum(m[1] as string);
      if (album === undefined) return error(404, "NOT_FOUND");
      const rows = [...media.values()].filter((x) => x.album === m?.[1]);
      if (req.method() === "GET" && m[2] === undefined) {
        return json(200, { id: album["id"], title: album["title"], created_at: album["created_at"], media: rows.map((r) => ({ id: r.id, kind: "photo", status: r.status, created_at: r.created_at })) });
      }
      if (req.method() === "GET" && m[2] === "/metadata") return json(200, { metadata: rows.filter((r) => r.status === "ready").map((r) => ({ media_id: r.id, envelope: r.metadata })) });
      if (req.method() === "GET" && m[2] === "/access-log") {
        const mine = [...recipients.entries()].filter(([, r]) => r.album === m?.[1]);
        const summary = mine.map(([rid, r]) => {
          const own = entries.filter((e) => e.recipient_id === rid);
          const last = own.map((e) => e.occurred_at).sort().at(-1) ?? null;
          return {
            recipient_id: rid,
            label: r.body["label"],
            revoked_at: r.revoked_at,
            album_opens: own.filter((e) => e.event === "album_opened").length,
            media_opened: new Set(own.filter((e) => e.event === "asset_viewed").map((e) => e.media_id)).size,
            last_opened_at: last,
          };
        });
        return json(200, { recipients: summary.sort((a, b) => (b.last_opened_at ?? "").localeCompare(a.last_opened_at ?? "")) });
      }
      if (req.method() === "GET" && m[2] === "/access-log/entries") {
        const before = url.searchParams.get("before");
        const who = url.searchParams.get("recipient_id");
        const ids = new Set([...recipients.entries()].filter(([, r]) => r.album === m?.[1]).map(([rid]) => rid));
        const rowsOut = entries
          .filter((e) => ids.has(e.recipient_id) && (before === null || e.id < Number(before)) && (who === null || e.recipient_id === who))
          .sort((a, b) => b.id - a.id);
        const page = rowsOut.slice(0, 100);
        return json(200, { entries: page, next_before: rowsOut.length > 100 ? (page.at(-1)?.id ?? null) : null });
      }
      if (req.method() === "POST" && m[2] === "/recipients") {
        if (instead !== undefined && typeof instead === "object") return error(instead.status, instead.status === 409 ? "CONFLICT" : "VALIDATION_FAILED");
        const b = JSON.parse(body) as Record<string, unknown>;
        const id = b["id"] as string;
        if (recipients.has(id) || [...recipients.values()].some((r) => r.body["token_hash"] === b["token_hash"])) return error(409, "CONFLICT");
        const created_at = now();
        recipients.set(id, { album: m[1] as string, body: b, created_at, revoked_at: null });
        return json(201, { id, created_at });
      }
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
    if ((m = /^\/v1\/recipients\/([0-9a-f-]{36})\/revoke$/.exec(url.pathname)) && req.method() === "POST") {
      const r = recipients.get(m[1] as string);
      if (r === undefined || ownAlbum(r.album) === undefined) return error(404, "NOT_FOUND");
      r.revoked_at ??= now();
      return json(200, { revoked_at: r.revoked_at });
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
    recipients,
    entries,
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
