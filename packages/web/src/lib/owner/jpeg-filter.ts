/*
 * Rewrites a canvas JPEG keeping only what an image needs: SOI, APP0 with a
 * JFIF signature, DQT, SOF0/1/2, DHT, DRI, each SOS with its entropy-coded
 * data, and EOI. Every other APPn (EXIF, XMP, ICC, maker data) and every COM
 * is dropped, and so is anything after EOI.
 *
 * This removes what a browser's encoder added. It is not what confirms
 * stripping: jpeg-scan.ts runs on this function's OUTPUT and still fails the
 * item on any finding (#11, #17), so a bug here can only fail an item, never
 * pass one unstripped.
 *
 * A marker outside that list that an image could need (arithmetic coding,
 * lossless or hierarchical frames, DNL) is not dropped and not kept: the
 * function answers null, and the item fails. Dropping a segment the decoder
 * needs would produce an image nobody asked for.
 */

const SOF = new Set([0xc0, 0xc1, 0xc2]);
const KEPT = new Set([0xdb, 0xc4, 0xdd, ...SOF]);
const JFIF = [0x4a, 0x46, 0x49, 0x46, 0x00]; // "JFIF\0"

export function keepImageSegments(b: Uint8Array): Uint8Array<ArrayBuffer> | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let sawFrame = false;
  let i = 2;
  for (;;) {
    if (i >= b.length || b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++; // fill bytes
    if (i >= b.length) return null;
    const marker = b[i] as number;
    const start = i - 1; // the 0xFF before the code
    i++;

    if (marker === 0xd9) {
      if (!sawFrame) return null;
      out.push(Uint8Array.of(0xff, 0xd9)); // anything after EOI is not kept
      break;
    }
    if (i + 2 > b.length) return null;
    const length = ((b[i] as number) << 8) | (b[i + 1] as number);
    if (length < 2 || i + length > b.length) return null;
    const end = i + length;
    const segment = b.subarray(start, end);

    if (marker === 0xe0) {
      if (JFIF.every((c, k) => b[i + 2 + k] === c)) out.push(segment);
    } else if ((marker >= 0xe1 && marker <= 0xef) || marker === 0xfe) {
      // Dropped: EXIF, XMP, ICC, maker data, comments.
    } else if (KEPT.has(marker)) {
      if (SOF.has(marker)) sawFrame = true;
      out.push(segment);
    } else if (marker === 0xda) {
      // SOS: its header, then entropy-coded data up to the next real marker.
      let j = end;
      for (;;) {
        if (j + 1 >= b.length) return null;
        if (b[j] === 0xff) {
          const next = b[j + 1] as number;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            j += 2;
            continue;
          }
          if (next === 0xff) {
            j++;
            continue;
          }
          break;
        }
        j++;
      }
      out.push(b.subarray(start, j));
      i = j;
      continue;
    } else {
      return null;
    }
    i = end;
  }

  const total = out.reduce((n, p) => n + p.length, 0);
  const result = new Uint8Array(total);
  let at = 0;
  for (const p of out) {
    result.set(p, at);
    at += p.length;
  }
  return result;
}
