/*
 * The invite QR (invite spec §3): the §2 URL verbatim, error correction M,
 * a quiet zone of 4 modules. Encoded by uqr (0.1.3, pinned exactly: no
 * dependencies, no network code, a port of Nayuki's qrcodegen) into a module
 * grid, and drawn by QrCode.svelte as one inline SVG path. Never a `data:`
 * image: CSP refuses those and must keep refusing them.
 *
 * uqr's own defaults are error correction L and a border of 1, both below
 * §3, so both are passed here explicitly and qr.test.ts reads them back out
 * of the grid itself (the format bits, and the light rows and columns).
 */
import { encode } from "uqr";

/** Invite spec §3: "M or higher". */
export const QR_ECC = "M" as const;
/** Invite spec §3: "at least 4 modules". */
export const QR_QUIET_ZONE = 4;

export type QrModules = {
  /** Modules per side, quiet zone included. */
  readonly size: number;
  /** `dark[y][x]`. */
  readonly dark: readonly (readonly boolean[])[];
};

export function qrModules(text: string): QrModules {
  const r = encode(text, { ecc: QR_ECC, border: QR_QUIET_ZONE });
  return { size: r.size, dark: r.data };
}

/** One path for every dark module, a horizontal run at a time, in module units. */
export function qrPath(m: QrModules): string {
  const parts: string[] = [];
  m.dark.forEach((row, y) => {
    let x = 0;
    while (x < m.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < m.size && row[x]) x++;
      parts.push(`M${start} ${y}h${x - start}v1h${start - x}z`);
    }
  });
  return parts.join("");
}
