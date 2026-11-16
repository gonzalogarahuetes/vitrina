/*
 * The recipient specs' album and relay, moved here unchanged from
 * recipient-reload.spec.ts when back.spec.ts needed them too, plus the
 * photo's full asset, so the viewer has something to show. Made with the
 * real envelope build, as an owner's client would make them (encryption spec
 * §6.1, §6.2), and answered behind context.route.
 */
import { type BrowserContext, type Route } from "@playwright/test";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { apiOrigin } from "./helpers.ts";

const WASM_DIR = new URL("../../../envelope/wasm/", import.meta.url);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const idBytes = (uuid: string) => Uint8Array.from(Buffer.from(uuid.replaceAll("-", ""), "hex"));

/** A valid 1×1 PNG: the thumbnail must decode, or its cell fails. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
export const WORDS = ["lantern", "orchard", "pebble", "meadow", "harbour"];

type Recipient = { id: string; token: string; kind: "qr" | "passphrase"; key: Record<string, unknown>; label: string; revoked: boolean };

/** The album, its two invites and the relay's answers, all made with the real envelope build. */
export async function fixtures() {
  const { default: init, ...envelope } = await import(new URL("envelope.js", WASM_DIR).href);
  await init({ module_or_path: await readFile(new URL("envelope_bg.wasm", WASM_DIR)) });

  const albumId = randomUUID();
  const mediaId = randomUUID();
  const album = envelope.AlbumKey.generate();

  const qrId = randomUUID();
  const invite = envelope.InviteKey.generate();
  const inviteWrapping = envelope.wrapAlbumKeyForInvite(album, invite, idBytes(qrId));
  const inviteKey = invite.toInviteBytes() as Uint8Array;
  invite.free();

  const passId = randomUUID();
  const params = new envelope.WrapParams(16384, 2, 1);
  const passWrapping = envelope.wrapAlbumKey(album, WORDS.join(" "), params, idBytes(passId));

  const recipients: Recipient[] = [
    {
      id: qrId,
      token: randomBytes(32).toString("base64url"),
      kind: "qr",
      key: { id: qrId, kind: "qr", wrapped: b64(inviteWrapping.wrapped), wrap_nonce: b64(inviteWrapping.wrapNonce) },
      label: b64(envelope.encryptRecipientLabel(album, idBytes(qrId), "María")),
      revoked: false,
    },
    {
      id: passId,
      token: randomBytes(32).toString("base64url"),
      kind: "passphrase",
      key: {
        id: passId,
        kind: "passphrase",
        kdf_salt: b64(passWrapping.kdfSalt),
        kdf_memory_kib: 16384,
        kdf_iterations: 2,
        kdf_parallelism: 1,
        wrapped: b64(passWrapping.wrapped),
        wrap_nonce: b64(passWrapping.wrapNonce),
      },
      label: b64(envelope.encryptRecipientLabel(album, idBytes(passId), "Abuelo")),
      revoked: false,
    },
  ];

  const albumJson = {
    id: albumId,
    title: b64(envelope.encryptAlbumTitle(album, idBytes(albumId), "Verano 2026")),
    created_at: "2026-10-01T00:00:00Z",
    media: [{ id: mediaId, kind: "photo", status: "ready", created_at: "2026-10-01T00:00:00Z" }],
  };
  const metadata = { metadata: [{ media_id: mediaId, envelope: b64(envelope.encryptMeta(album, idBytes(mediaId), Buffer.from('{"width":1,"height":1}'))) }] };
  const thumbnail = envelope.encryptThumb(album, idBytes(mediaId), PNG) as Uint8Array;
  const asset = envelope.encryptAsset(album, idBytes(mediaId), PNG) as Uint8Array;
  album.free();

  const base = `v=1&a=${b64(idBytes(albumId))}`;
  const qr = recipients[0] as Recipient;
  const pass = recipients[1] as Recipient;
  return {
    recipients,
    albumId,
    albumJson,
    metadata,
    mediaId,
    thumbnail,
    asset,
    qr,
    pass,
    qrFragment: `#${base}&t=${qr.token}&k=${b64(inviteKey)}`,
    passFragment: `#${base}&t=${pass.token}`,
    /** K_invite in the spellings the secret search looks for. */
    inviteSecrets: [b64(inviteKey), Buffer.from(inviteKey).toString("base64"), Buffer.from(inviteKey).toString("hex")],
  };
}

export type Fixtures = Awaited<ReturnType<typeof fixtures>>;

/** Every request the app makes to the API, answered from the fixtures; CORS as a real relay sends it. */
export async function relay(context: BrowserContext, f: Fixtures, pageOrigin: string): Promise<{ paths: string[] }> {
  const paths: string[] = [];
  const origin = apiOrigin();
  async function handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const cors = {
      "access-control-allow-origin": pageOrigin,
      "access-control-allow-headers": "authorization, content-type, range",
      "access-control-allow-methods": "GET",
      "access-control-expose-headers": "retry-after",
      "cache-control": "no-store",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    paths.push(url.pathname);
    const json = (status: number, value: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(value) });
    const token = (await req.allHeaders())["authorization"]?.replace(/^Bearer /, "");
    const r = f.recipients.find((x) => x.token === token);
    if (r === undefined) return json(401, { code: "UNAUTHENTICATED", message: "x" });
    if (r.revoked) return json(403, { code: "ACCESS_REVOKED", message: "x" });
    switch (url.pathname) {
      case "/v1/recipient/key":
        return json(200, r.key);
      case "/v1/recipient":
        return json(200, { id: r.id, album_id: f.albumId, label: r.label, kind: r.kind, created_at: "2026-10-01T00:00:00Z" });
      case `/v1/albums/${f.albumId}`:
        return json(200, f.albumJson);
      case `/v1/albums/${f.albumId}/metadata`:
        return json(200, f.metadata);
      case `/v1/media/${f.mediaId}/thumbnail`:
        return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/octet-stream" }, body: Buffer.from(f.thumbnail) });
      case `/v1/media/${f.mediaId}/asset`:
        return route.fulfill({ status: 206, headers: { ...cors, "content-type": "application/octet-stream" }, body: Buffer.from(f.asset) });
      default:
        return json(404, { code: "NOT_FOUND", message: "x" });
    }
  }
  await context.route((u) => u.origin === origin, handle);
  return { paths };
}

