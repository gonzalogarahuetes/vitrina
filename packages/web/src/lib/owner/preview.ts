/*
 * The review step's previews (flows §3.6, before step 1): a small, upright
 * picture of each chosen photo, so the owner can tell which one a caption is
 * for and take out a wrong one before anything happens to it.
 *
 * For the screen only. Nothing here is uploaded, and preparation decodes the
 * original again from the file (prepare.ts): the cost is a second decode per
 * photo, which buys a review step that holds nothing but small bitmaps.
 *
 * Memory (brief §11): one decode, asked for at preview size with EXIF
 * orientation applied. A browser that ignores the size, or a portrait photo
 * whose width was the short edge, gives a larger bitmap; that is drawn down to
 * preview size and closed at once, so at most one large bitmap is ever open,
 * and only the small ones are kept. Callers run one preview at a time.
 */
import { THUMB_LONG_EDGE, fitLongEdge, type Bitmap, type Dims, type Imaging } from "./prepare";

export const PREVIEW_LONG_EDGE = THUMB_LONG_EDGE;

/** Draws `bitmap` at `size` and returns the result as a new bitmap. The caller closes `bitmap`. */
export type Shrink = (bitmap: Bitmap, size: Dims) => Promise<Bitmap>;

export async function makePreview(file: Blob, decode: Imaging["decode"], shrink: Shrink): Promise<Bitmap> {
  const b = await decode(file, { width: PREVIEW_LONG_EDGE });
  let keep = false;
  try {
    if (!(Number.isSafeInteger(b.width) && Number.isSafeInteger(b.height) && b.width >= 1 && b.height >= 1)) throw new Error("not decoded");
    const size = fitLongEdge(b, PREVIEW_LONG_EDGE);
    if (size.width === b.width && size.height === b.height) {
      keep = true;
      return b;
    }
    return await shrink(b, size);
  } finally {
    if (!keep) b.close();
  }
}
