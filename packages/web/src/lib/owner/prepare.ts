/*
 * Flows §3.6 step 1, per photo, on the device and in this order:
 *
 *   1. decode with EXIF orientation applied to the pixels (encryption spec
 *      §7: orientation before stripping), downscaled during the decode where
 *      the browser does that;
 *   2. downscale so the long edge is at most 1600 px, never up (#14);
 *   3. draw to a canvas and re-encode as JPEG. The re-encode is what strips
 *      EXIF and GPS (#11): the canvas has pixels and nothing else. The
 *      encoder's own extra segments (an ICC profile, an APP1 some browsers
 *      write) are then dropped (jpeg-filter.ts);
 *   4. the thumbnail the same way, 480 px, and one chunk at most (#13;
 *      api-sketch §11.3);
 *   5. the metadata document of encryption spec §7: the dimensions as
 *      encrypted, and the original filename (#12), which exists nowhere else.
 *
 * Stripping is structural, so it is TESTED on the output rather than assumed:
 * both JPEGs are scanned (jpeg-scan.ts) and anything found fails the item
 * (#17). It is never uploaded unstripped. Nothing here encrypts; the caller
 * does, under the media id, with the AlbumKey it holds.
 *
 * Memory (brief §11). A 48-megapixel photo is ~190 MB as a bitmap. For a JPEG,
 * the stored frame size is read from the file's first bytes (its SOF marker),
 * which says whether the photo needs downscaling and to what long edge;
 * rotation only swaps width and height, so the long edge is known before the
 * orientation is. The decode then asks for that long edge. A browser that does
 * not honour the request, or honours it wrongly, gets a full-size decode drawn
 * down instead: one full-size bitmap is the worst case, and it is closed as
 * soon as the two JPEGs are drawn. Whether a browser's resized decode actually
 * avoids the full-size allocation internally is the browser's business; a
 * phone is the only way to find out.
 *
 * The decoding and drawing are injected (imaging.ts in the browser), so every
 * rule below runs under test without a browser.
 */
import { keepImageSegments } from "./jpeg-filter";
import { jpegFrameSize, scanJpeg, type ScanFinding } from "./jpeg-scan";

export const ASSET_LONG_EDGE = 1600;
export const THUMB_LONG_EDGE = 480;
/** Encryption spec §3.1: a v1 writer's chunk size. A thumbnail must fit in one (api-sketch §11.3). */
export const CHUNK_SIZE = 262144;
/** api-sketch §9.6: the metadata envelope's decoded length is at most 4096; a one-chunk envelope adds 64 + 16. */
export const META_MAX_PLAINTEXT = 4096 - 64 - 16;
/** How much of an original is read to find its frame size. EXIF and its embedded thumbnail come first, in up to 64 KiB. */
export const HEAD_BYTES = 256 * 1024;

export const ASSET_QUALITY = 0.85;
export const THUMB_QUALITY = 0.8;

export type Dims = { readonly width: number; readonly height: number };
export type Bitmap = Dims & { close(): void };
/** Ask for one edge; the browser derives the other from the oriented aspect. */
export type Resize = { readonly width: number } | { readonly height: number };

export type Imaging = {
  /** Decodes with EXIF orientation applied to the pixels, downscaled to `resize` if given and honoured. */
  decode(file: Blob, resize: Resize | null): Promise<Bitmap>;
  /** Draws `bitmap` at `size` on a canvas and encodes it. Returns what toBlob returned, unexamined. */
  encode(
    bitmap: Bitmap,
    size: Dims,
    type: "image/jpeg",
    quality: number,
  ): Promise<Blob | null>;
};

export type PrepareError =
  /** The file could not be decoded, or came out a shape it cannot be. Nothing was sent. */
  | "not-decoded"
  /** The canvas did not give back a JPEG of the size asked for (toBlob's silent PNG fallback included). */
  | "not-encoded"
  /** Metadata was found in an output (#11, #17). */
  | "not-stripped"
  /** The thumbnail is more than one chunk. */
  | "thumb-too-large"
  /** The metadata document would exceed api-sketch §9.6's body cap. */
  | "meta-too-large";

export type Prepared = {
  readonly asset: Uint8Array<ArrayBuffer>;
  readonly thumb: Uint8Array<ArrayBuffer>;
  readonly meta: Uint8Array<ArrayBuffer>;
  /** The asset as encrypted, which is what the metadata says. */
  readonly size: Dims;
};

export type PrepareResult =
  | { readonly ok: true; readonly prepared: Prepared }
  | {
      readonly ok: false;
      readonly error: PrepareError;
      readonly finding?: ScanFinding;
    };

const longEdge = (d: Dims): number => Math.max(d.width, d.height);

/** The long edge brought down to `max`, aspect kept, never upscaled. */
export function fitLongEdge(d: Dims, max: number): Dims {
  const long = longEdge(d);
  if (long <= max) return { width: d.width, height: d.height };
  const k = max / long;
  return d.width >= d.height
    ? { width: max, height: Math.max(1, Math.round(d.height * k)) }
    : { width: Math.max(1, Math.round(d.width * k)), height: max };
}

/**
 * A bitmap is the shape of its stored frame, or of that frame turned a
 * quarter: rotation swaps the edges and changes nothing else. A browser that
 * resized before rotating, or squashed the photo, fails this.
 */
export function plausible(frame: Dims, got: Dims): boolean {
  const want = frame.width / frame.height;
  const have = got.width / got.height;
  const near = (a: number, b: number) => Math.abs(a - b) / b < 0.01;
  return near(have, want) || near(have, 1 / want);
}

type Encoded =
  | { readonly ok: true; readonly bytes: Uint8Array<ArrayBuffer> }
  | {
      readonly ok: false;
      readonly error: PrepareError;
      readonly finding?: ScanFinding;
    };

async function jpeg(
  imaging: Imaging,
  bitmap: Bitmap,
  size: Dims,
  quality: number,
): Promise<Encoded> {
  let blob: Blob | null;
  try {
    blob = await imaging.encode(bitmap, size, "image/jpeg", quality);
  } catch {
    return { ok: false, error: "not-encoded" };
  }
  // toBlob answers an unsupported type with PNG, silently. Only JPEG is accepted.
  if (blob === null || blob.type !== "image/jpeg")
    return { ok: false, error: "not-encoded" };
  const raw = new Uint8Array(await blob.arrayBuffer());
  // Keep only the image's own segments, then scan what is left: the filter removes what
  // the browser added, and the scan is still what confirms nothing remains (#17).
  const bytes = keepImageSegments(raw);
  raw.fill(0);
  if (bytes === null) return { ok: false, error: "not-encoded" };
  const scan = scanJpeg(bytes);
  if (!scan.ok) {
    bytes.fill(0);
    if (scan.finding === "not-jpeg" || scan.finding === "malformed")
      return { ok: false, error: "not-encoded", finding: scan.finding };
    return { ok: false, error: "not-stripped", finding: scan.finding };
  }
  if (scan.width !== size.width || scan.height !== size.height) {
    bytes.fill(0);
    return { ok: false, error: "not-encoded" };
  }
  return { ok: true, bytes };
}

/**
 * One decode at the target long edge where that works, else one at full
 * size. At most one bitmap is open at a time; any bitmap not returned is
 * closed before the next decode starts.
 */
async function decode(file: File, imaging: Imaging): Promise<Bitmap | null> {
  let frame: Dims | null = null;
  try {
    frame = jpegFrameSize(
      new Uint8Array(await file.slice(0, HEAD_BYTES).arrayBuffer()),
    );
  } catch {
    frame = null; // not readable as bytes: decode it whole and let that fail if it must
  }

  if (frame !== null && longEdge(frame) > ASSET_LONG_EDGE) {
    let b = await imaging.decode(file, { width: ASSET_LONG_EDGE });
    if (b.height > b.width) {
      // Portrait once oriented: the width was the short edge. Ask for the height instead.
      b.close();
      b = await imaging.decode(file, { height: ASSET_LONG_EDGE });
    }
    if (longEdge(b) === ASSET_LONG_EDGE && plausible(frame, b)) return b;
    b.close(); // not honoured, or honoured wrongly
  }

  const full = await imaging.decode(file, null);
  if (
    frame !== null &&
    (longEdge(full) !== longEdge(frame) || !plausible(frame, full))
  ) {
    full.close();
    return null;
  }
  return full;
}

export async function prepare(
  file: File,
  imaging: Imaging,
): Promise<PrepareResult> {
  let bitmap: Bitmap | null;
  try {
    bitmap = await decode(file, imaging);
  } catch {
    return { ok: false, error: "not-decoded" };
  }
  if (bitmap === null) return { ok: false, error: "not-decoded" };
  if (
    !Number.isSafeInteger(bitmap.width) ||
    !Number.isSafeInteger(bitmap.height) ||
    bitmap.width < 1 ||
    bitmap.height < 1
  ) {
    bitmap.close();
    return { ok: false, error: "not-decoded" };
  }

  // The bitmap is oriented, so these are the dimensions as they will be encrypted.
  const size = fitLongEdge(bitmap, ASSET_LONG_EDGE);
  const thumbSize = fitLongEdge(size, THUMB_LONG_EDGE);

  let asset: Encoded;
  let thumb: Encoded;
  try {
    asset = await jpeg(imaging, bitmap, size, ASSET_QUALITY);
    if (!asset.ok) return asset;
    thumb = await jpeg(imaging, bitmap, thumbSize, THUMB_QUALITY);
    if (!thumb.ok) {
      asset.bytes.fill(0);
      return thumb;
    }
  } finally {
    bitmap.close();
  }

  if (thumb.bytes.length > CHUNK_SIZE) {
    asset.bytes.fill(0);
    thumb.bytes.fill(0);
    return { ok: false, error: "thumb-too-large" };
  }

  // Encryption spec §7, fixed 15 October 2026. No taken_at in v1: reading it means parsing EXIF.
  const doc: Record<string, unknown> = {
    width: size.width,
    height: size.height,
  };
  if (file.name !== "") doc["name"] = file.name;
  const meta = new TextEncoder().encode(
    JSON.stringify(doc),
  ) as Uint8Array<ArrayBuffer>;
  if (meta.length > META_MAX_PLAINTEXT) {
    asset.bytes.fill(0);
    thumb.bytes.fill(0);
    meta.fill(0);
    return { ok: false, error: "meta-too-large" };
  }

  return {
    ok: true,
    prepared: { asset: asset.bytes, thumb: thumb.bytes, meta, size },
  };
}
