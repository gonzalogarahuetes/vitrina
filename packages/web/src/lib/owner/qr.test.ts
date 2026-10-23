/*
 * Invite spec §3's requirements, read back out of the grid uqr produced
 * rather than trusted from the options passed, and §7 item 2: object → URL →
 * QR → decode → object, through a second implementation (jsQR) and the
 * owner's parser.
 */
import { encodeBase64url } from "@vitrina/shared";
import jsQR from "jsqr";
import { describe, expect, it } from "vitest";
import { parseInvite } from "$lib/invite/parse";
import { inviteLink } from "$lib/invite/url";
import { qrModules, qrPath, QR_QUIET_ZONE, type QrModules } from "./qr";

const ALBUM = Uint8Array.from({ length: 16 }, (_, i) => 0x10 + i);
const TOKEN = encodeBase64url(Uint8Array.from({ length: 32 }, (_, i) => 0x40 + i));
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, i) => 0x90 + i);
const KEY = encodeBase64url(KEY_BYTES);
// A long origin, so the size check covers more than the spec's typical payload.
const QR_URL = inviteLink({ origin: "https://vitrina.family-photos.example:8443", albumId: ALBUM, token: TOKEN, inviteKey: KEY });
const PASS_URL = inviteLink({ origin: "https://vitrina.example", albumId: ALBUM, token: TOKEN });

/** The light border's width: rows and columns from each edge that hold no dark module. */
function quietZone(m: QrModules): number {
  const light = (i: number) =>
    m.dark[i]?.every((d) => !d) &&
    m.dark[m.size - 1 - i]?.every((d) => !d) &&
    m.dark.every((row) => !row[i] && !row[m.size - 1 - i]);
  let n = 0;
  while (n < m.size / 2 && light(n)) n++;
  return n;
}

/**
 * The error correction level, from the format information beside the top-left
 * finder (ISO/IEC 18004 §7.9): 15 bits, masked with 0x5412, level in the top
 * two. 1 = L, 0 = M, 3 = Q, 2 = H.
 */
function eccLevel(m: QrModules): "L" | "M" | "Q" | "H" {
  const b = quietZone(m);
  const at = (x: number, y: number) => (m.dark[y + b]?.[x + b] ? 1 : 0);
  const cells: [number, number][] = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
    [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  let bits = 0;
  cells.forEach(([x, y], i) => (bits |= at(x, y) << i));
  bits ^= 0x5412;
  return (["M", "L", "H", "Q"] as const)[bits >>> 13] ?? "L";
}

/** The grid drawn at `scale` pixels per module, as RGBA, the way a camera would see the SVG. */
function raster(m: QrModules, scale: number): { data: Uint8ClampedArray; side: number } {
  const side = m.size * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      if (m.dark[Math.floor(y / scale)]?.[Math.floor(x / scale)]) data.fill(0, (y * side + x) * 4, (y * side + x) * 4 + 3);
    }
  }
  return { data, side };
}

/** The grid qrPath's runs cover, so the SVG is known to draw exactly the dark modules. */
function fromPath(d: string, size: number): boolean[][] {
  const grid = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
  for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) (grid[Number(y)] as boolean[])[Number(x) + i] = true;
  }
  return grid;
}

describe("the invite QR (invite spec §3)", () => {
  for (const [name, url] of [["QR mode", QR_URL], ["passphrase mode", PASS_URL]] as const) {
    describe(name, () => {
      const m = qrModules(url);

      it("uses error correction M or higher", () => {
        expect(["M", "Q", "H"]).toContain(eccLevel(m));
      });

      it(`has a quiet zone of at least ${QR_QUIET_ZONE} modules`, () => {
        expect(quietZone(m)).toBeGreaterThanOrEqual(4);
      });

      it("stays at a version a phone reads off a screen (§3's size check: 7–9 at M)", () => {
        const version = (m.size - 2 * quietZone(m) - 17) / 4;
        expect(Number.isInteger(version)).toBe(true);
        expect(version).toBeLessThanOrEqual(10);
      });

      it("round-trips: URL → QR → decode → URL → payload (§7 item 2)", () => {
        const { data, side } = raster(m, 4);
        const decoded = jsQR(data, side, side);
        expect(decoded?.data).toBe(url);
        const parsed = parseInvite(new URL(decoded?.data ?? "").hash);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) {
          expect(parsed.invite.token).toBe(TOKEN);
          expect(parsed.invite.albumId).toEqual(ALBUM);
          if (name === "QR mode") expect(parsed.invite.mode === "qr" && parsed.invite.inviteKey).toEqual(KEY_BYTES);
          else expect(parsed.invite.mode).toBe("passphrase");
        }
      });

      it("the SVG path draws exactly the dark modules", () => {
        expect(fromPath(qrPath(m), m.size)).toEqual(m.dark.map((r) => [...r]));
      });
    });
  }

  it("the ECC reader is sound: it tells L from M on a grid made at L", async () => {
    const { encode } = await import("uqr");
    const r = encode(PASS_URL, { ecc: "L", border: 4 });
    expect(eccLevel({ size: r.size, dark: r.data })).toBe("L");
    const q = encode(PASS_URL, { ecc: "Q", border: 4 });
    expect(eccLevel({ size: q.size, dark: q.data })).toBe("Q");
  });

  it("the quiet-zone reader is sound: uqr's default border of 1 reads as 1", async () => {
    const { encode } = await import("uqr");
    const r = encode(PASS_URL, { ecc: "M" });
    expect(quietZone({ size: r.size, dark: r.data })).toBe(1);
  });
});
