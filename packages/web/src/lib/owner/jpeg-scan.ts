/*
 * Confirms that a JPEG the canvas produced carries no EXIF, XMP or GPS
 * (non-negotiable #11), by reading its bytes, not by trusting the encoder.
 * Non-negotiable #17: anything this cannot confirm is a failure. So the walk
 * is an allowlist: every marker segment is either one the encoder has a reason
 * to write (JFIF, an ICC profile, the image's own tables and frame) or a
 * finding, and bytes it cannot parse are a finding too.
 *
 * Also reads the frame's dimensions, so the caller can check that what was
 * encoded is the size it asked for.
 */

export type ScanFinding =
  /** No SOI, so not a JPEG at all. */
  | "not-jpeg"
  /** A segment runs off the end, a length is impossible, or there is no frame or no EOI. */
  | "malformed"
  /** APP1 with an Exif signature, or the signature anywhere in the file. */
  | "exif"
  /** APP1 with an XMP signature, or an XMP packet anywhere in the file. */
  | "xmp"
  /** A GPS tag name anywhere in the file. */
  | "gps"
  /** Any other APPn (APP1 unrecognised, APP13 IPTC, maker data, …), or APP0/APP2 with a foreign signature. */
  | "app-segment"
  /** A COM segment: free text the encoder has no reason to write. */
  | "comment"
  /** Bytes after EOI: where phones append trailers and second images. */
  | "trailing-data";

export type ScanResult =
  | { readonly ok: true; readonly width: number; readonly height: number }
  | { readonly ok: false; readonly finding: ScanFinding };

const ascii = (s: string): Uint8Array =>
  Uint8Array.from(s, (c) => c.charCodeAt(0));

/* Searched over the whole file, header and entropy-coded data alike. Long enough that a chance match in compressed data is not a concern. */
const SIGNATURES: readonly [Uint8Array, ScanFinding][] = [
  [ascii("Exif\u0000\u0000"), "exif"],
  // The XMP namespace without its scheme: check-build.mjs refuses a URL in the bundle.
  [ascii("ns.adobe.com/xap/1.0/"), "xmp"],
  [ascii("<x:xmpmeta"), "xmp"],
  [ascii("<?xpacket"), "xmp"],
  [ascii("GPSLatitude"), "gps"],
  [ascii("GPSLongitude"), "gps"],
];

function startsWith(b: Uint8Array, at: number, sig: Uint8Array): boolean {
  if (at + sig.length > b.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

function contains(b: Uint8Array, sig: Uint8Array): boolean {
  const first = sig[0];
  for (
    let i = b.indexOf(first ?? 0);
    i !== -1 && i + sig.length <= b.length;
    i = b.indexOf(first ?? 0, i + 1)
  ) {
    if (startsWith(b, i, sig)) return true;
  }
  return false;
}

const JFIF = ascii("JFIF\u0000");
const JFXX = ascii("JFXX\u0000");
const ICC = ascii("ICC_PROFILE\u0000");
const EXIF_APP1 = ascii("Exif\u0000");
const XMP_NS = ascii("ns.adobe.com/");

/* Frame markers that carry dimensions: baseline, extended, progressive. The arithmetic and lossless ones a canvas never writes. */
const SOF = new Set([0xc0, 0xc1, 0xc2]);
/* Markers whose segments are image data the decoder needs: tables, restart interval, frame. */
const IMAGE_SEGMENTS = new Set([0xc4, 0xdb, 0xdd, 0xc0, 0xc1, 0xc2]);

/** A segment's verdict, or null when it is permitted. */
function segmentFinding(
  b: Uint8Array,
  marker: number,
  dataAt: number,
  end: number,
): ScanFinding | null {
  if (marker === 0xe0)
    return startsWith(b, dataAt, JFIF) || startsWith(b, dataAt, JFXX)
      ? null
      : "app-segment";
  if (marker === 0xe2) return startsWith(b, dataAt, ICC) ? null : "app-segment";
  if (marker === 0xe1)
    return startsWith(b, dataAt, EXIF_APP1)
      ? "exif"
      : contains(b.subarray(dataAt, end), XMP_NS)
        ? "xmp"
        : "app-segment";
  if (marker >= 0xe3 && marker <= 0xef) return "app-segment";
  if (marker === 0xfe) return "comment";
  if (marker === 0xda || IMAGE_SEGMENTS.has(marker)) return null;
  // DNL, DHP, EXP, JPG extensions, arithmetic coding tables: nothing a canvas writes.
  return "app-segment";
}

/**
 * The stored frame size of an ORIGINAL file, from its SOF segment, for
 * choosing a downscaled decode. Reads markers only, never their contents:
 * this is not the EXIF parser the brief avoids. Not oriented — but its long
 * edge is the oriented long edge, because rotation only swaps the two.
 * Null when `b` is not a JPEG or the frame is not within it.
 */
export function jpegFrameSize(
  b: Uint8Array,
): { readonly width: number; readonly height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    while (i < b.length && b[i] === 0xff) i++;
    const marker = b[i] as number;
    i++;
    if (marker === 0xd9 || marker === 0xda) return null;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (i + 2 > b.length) return null;
    const length = ((b[i] as number) << 8) | (b[i + 1] as number);
    if (length < 2) return null;
    if (
      SOF.has(marker) ||
      (marker >= 0xc3 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc)
    ) {
      if (i + 7 > b.length) return null;
      const height = ((b[i + 3] as number) << 8) | (b[i + 4] as number);
      const width = ((b[i + 5] as number) << 8) | (b[i + 6] as number);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += length;
  }
  return null;
}

export function scanJpeg(b: Uint8Array): ScanResult {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8)
    return { ok: false, finding: "not-jpeg" };

  // Whole-file signatures first: they name what was found, wherever it is.
  for (const [sig, finding] of SIGNATURES)
    if (contains(b, sig)) return { ok: false, finding };

  let width = 0;
  let height = 0;
  let i = 2;
  for (;;) {
    // A marker: 0xFF, optional 0xFF fill bytes, then the code.
    if (i >= b.length || b[i] !== 0xff)
      return { ok: false, finding: "malformed" };
    while (i < b.length && b[i] === 0xff) i++;
    if (i >= b.length) return { ok: false, finding: "malformed" };
    const marker = b[i] as number;
    i++;

    if (marker === 0xd9) {
      // EOI. Before any frame is malformed; anything after it is trailing data.
      if (width === 0 || height === 0)
        return { ok: false, finding: "malformed" };
      return i === b.length
        ? { ok: true, width, height }
        : { ok: false, finding: "trailing-data" };
    }
    if (
      marker === 0xd8 ||
      marker === 0x00 ||
      (marker >= 0xd0 && marker <= 0xd7) ||
      marker === 0x01
    ) {
      // A second SOI, a stuffed zero, or a restart outside entropy-coded data.
      return { ok: false, finding: "malformed" };
    }

    if (i + 2 > b.length) return { ok: false, finding: "malformed" };
    const length = ((b[i] as number) << 8) | (b[i + 1] as number);
    if (length < 2 || i + length > b.length)
      return { ok: false, finding: "malformed" };
    const dataAt = i + 2;
    const finding = segmentFinding(b, marker, dataAt, i + length);
    if (finding !== null) return { ok: false, finding };

    if (SOF.has(marker)) {
      if (length < 8) return { ok: false, finding: "malformed" };
      height = ((b[dataAt + 1] as number) << 8) | (b[dataAt + 2] as number);
      width = ((b[dataAt + 3] as number) << 8) | (b[dataAt + 4] as number);
    }
    i += length;

    if (marker === 0xda) {
      // Entropy-coded data until the next marker that is not a stuffed 0x00 or a restart.
      for (;;) {
        if (i + 1 >= b.length) return { ok: false, finding: "malformed" };
        if (b[i] === 0xff) {
          const next = b[i + 1] as number;
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            i += 2;
            continue;
          }
          if (next === 0xff) {
            i++;
            continue;
          }
          break; // a real marker: back to the segment walk
        }
        i++;
      }
    }
  }
}
