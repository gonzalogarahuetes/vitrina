/*
 * The recipient path against the real envelope build: the session's glue calls
 * decryptRecipientLabel, decryptAlbumTitle, decryptMeta, decryptThumb and
 * decryptAsset with the right ids in the right places, or this fails.
 *
 * The AlbumKey handle is a FIXTURE built in setup, and the fake openDirectKey
 * returns it without reading the bytes it is given: opening the key is the
 * owner's function and is not exercised here.
 */
import { createApiClient } from "$lib/api/client";
import { loadEnvelope } from "$lib/envelope";
import { uuidToBytes } from "$lib/ids";
import type { AlbumKey } from "$lib/keys/types";
import { encodeBase64url } from "@vitrina/shared";
import { describe, expect, it } from "vitest";
import { ALBUM_ID, FakePicture, KEY, QR_FRAGMENT, RECIPIENT_ID, TOKEN, media, settle } from "./harness.test-support";
import { RecipientSession } from "./session";

describe("the recipient path over the real envelope build", () => {
  it("opens label, title, metadata, thumbnails and a multi-chunk asset", async () => {
    const { envelope, poison } = await loadEnvelope();
    const fixture = envelope.AlbumKey.fromBytes(Uint8Array.from(KEY));
    const ids = [media(1).id, media(2).id];
    const text = (s: string) => new TextEncoder().encode(s);
    // Over 256 KiB, so the asset envelope has three chunks.
    const big = new Uint8Array(600 * 1024).map((_, i) => (i * 31) & 0xff);
    const objects = new Map<string, Uint8Array>([
      [`/v1/media/${ids[0]}/thumbnail`, envelope.encryptThumb(fixture, uuidToBytes(ids[0] ?? ""), text("thumb one"))],
      [`/v1/media/${ids[1]}/thumbnail`, envelope.encryptThumb(fixture, uuidToBytes(ids[1] ?? ""), text("thumb two"))],
      [`/v1/media/${ids[1]}/asset`, envelope.encryptAsset(fixture, uuidToBytes(ids[1] ?? ""), big)],
    ]);
    const json: Record<string, unknown> = {
      "/v1/recipient": {
        id: RECIPIENT_ID,
        album_id: ALBUM_ID,
        label: encodeBase64url(envelope.encryptRecipientLabel(fixture, uuidToBytes(RECIPIENT_ID), "María")),
        kind: "qr",
        created_at: "x",
      },
      [`/v1/albums/${ALBUM_ID}`]: {
        id: ALBUM_ID,
        title: encodeBase64url(envelope.encryptAlbumTitle(fixture, uuidToBytes(ALBUM_ID), "Verano 2026 · la playa")),
        created_at: "x",
        media: [media(1), media(2)],
      },
      [`/v1/albums/${ALBUM_ID}/metadata`]: {
        metadata: ids.map((id) => ({
          media_id: id,
          envelope: encodeBase64url(envelope.encryptMeta(fixture, uuidToBytes(id), text(JSON.stringify({ width: 1600, height: 1200 })))),
        })),
      },
    };
    const fetchImpl = (async (input: string) => {
      const path = new URL(input).pathname;
      const bytes = objects.get(path);
      if (bytes !== undefined) return new Response(bytes as Uint8Array<ArrayBuffer>, { status: path.endsWith("/asset") ? 206 : 200 });
      return Response.json(json[path] ?? { code: "NOT_FOUND", message: "x" }, { status: path in json ? 200 : 404 });
    }) as unknown as typeof fetch;

    const decoded: Uint8Array[] = [];
    const session = new RecipientSession({
      client: createApiClient("https://api.vitrina.test", fetchImpl),
      envelope,
      poison,
      parseInvite: () => ({ ok: true, invite: { mode: "qr", albumId: uuidToBytes(ALBUM_ID), token: TOKEN, key: Uint8Array.from(KEY) } }),
      openDirectKey: () => ({ ok: true, albumKey: fixture as unknown as AlbumKey }),
      openPassphraseKey: () => Promise.reject(new Error("unused")),
      decodeImage: async (bytes) => {
        decoded.push(Uint8Array.from(bytes));
        return new FakePicture(bytes.length > 64 ? `${bytes.length} bytes` : new TextDecoder().decode(bytes));
      },
      sleep: async () => undefined,
      nextFrames: async () => undefined,
      now: () => new Date("2026-08-06T12:00:00Z"),
    });

    session.start(QR_FRAGMENT);
    await settle();
    expect(session.current.screen.kind).toBe("onboarding");
    session.enterGrid();
    await settle();
    const grid = session.current.screen;
    if (grid.kind !== "album") throw new Error(grid.kind);
    expect(grid.title).toBe("Verano 2026 · la playa");
    expect(grid.watermark).toEqual(["Shared with María", "6 Aug 2026"]);
    expect(grid.items.map((i) => i.size)).toEqual([{ w: 1600, h: 1200 }, { w: 1600, h: 1200 }]);
    expect(grid.items.map((i) => (i.thumb.kind === "ready" ? (i.thumb.picture as FakePicture).source : i.thumb.kind))).toEqual(["thumb one", "thumb two"]);

    session.openViewer(1);
    await settle();
    const viewer = session.current.screen.kind === "album" ? session.current.screen.viewer : null;
    expect(viewer?.phase).toBe("shown");
    // Byte comparison, not toEqual: Vitest's deep equality walks 600 KiB one
    // element at a time (about 1.4 s), which is what timed this test out in CI.
    const shown = decoded.at(-1);
    expect(shown?.length).toBe(big.length);
    expect(shown !== undefined && Buffer.from(shown).equals(Buffer.from(big))).toBe(true);
    session.dispose();
  });
});
