/*
 * prepare.ts's Imaging, in the browser. Decoding is exercised by the browser
 * check (test/browser/owner-album.spec.ts) only. Encoding takes its canvas
 * from a factory, so its one check of its own, the colour space, runs under
 * unit tests too (imaging.test.ts). prepare.ts decides what to ask for and
 * checks every answer.
 *
 * No blob URL and no image element: the original goes straight from the File to a
 * bitmap, as the recipient's decrypted images do (render.test.ts enforces it).
 */
import type { Bitmap, Dims, Imaging, Resize } from "./prepare";

async function decode(file: Blob, resize: Resize | null): Promise<Bitmap> {
  const resizeOpts: ImageBitmapOptions =
    resize === null
      ? {}
      : "width" in resize
        ? { resizeWidth: resize.width, resizeQuality: "high" }
        : { resizeHeight: resize.height, resizeQuality: "high" };
  try {
    return await createImageBitmap(file, {
      imageOrientation: "from-image",
      ...resizeOpts,
    });
  } catch (e) {
    // A browser that rejects the `from-image` value: its default, which the spec makes
    // from-image. prepare.ts checks the result's shape against the stored frame either way.
    if (e instanceof TypeError) return createImageBitmap(file, resizeOpts);
    throw e;
  }
}

/**
 * Only a reported mismatch fails. A browser whose getContextAttributes() has no
 * `colorSpace` (older Safari) is accepted: it predates canvas colour spaces,
 * and its canvas is sRGB. Failing it would fail every upload on that browser.
 */
export function reportsOtherColorSpace(ctx: {
  getContextAttributes?: () => { colorSpace?: unknown };
}): boolean {
  const space =
    typeof ctx.getContextAttributes === "function"
      ? ctx.getContextAttributes().colorSpace
      : undefined;
  return space !== undefined && space !== "srgb";
}

/** The canvas parts encode uses: HTMLCanvasElement satisfies it. */
export type EncodeCanvas = {
  width: number;
  height: number;
  getContext(
    kind: "2d",
    settings: CanvasRenderingContext2DSettings,
  ): CanvasRenderingContext2D | null;
  toBlob(callback: BlobCallback, type?: string, quality?: number): void;
};

export function makeEncode(newCanvas: () => EncodeCanvas): Imaging["encode"] {
  return (bitmap, size, type, quality) =>
    encodeOn(newCanvas(), bitmap, size, type, quality);
}

async function encodeOn(
  canvas: EncodeCanvas,
  bitmap: Bitmap,
  size: Dims,
  type: "image/jpeg",
  quality: number,
): Promise<Blob | null> {
  canvas.width = size.width;
  canvas.height = size.height;
  try {
    // sRGB, stated rather than left to the default: drawImage converts the photo
    // (a Display P3 iPhone photo included) into these pixels, so the JPEG holds sRGB.
    // jpeg-filter.ts depends on this: it drops every APP2, the ICC profile among
    // them, and an untagged JPEG is read as sRGB. Pixels in any other space would
    // then show with shifted colours, silently, with nothing failing.
    const ctx = canvas.getContext("2d", { colorSpace: "srgb" });
    if (ctx === null) return null;
    // The request above can be ignored. A browser that says it gave us another space
    // is believed, and the item fails (prepare.ts: not-encoded) rather than upload
    // pixels the dropped profile would have described (#17).
    if (reportsOtherColorSpace(ctx)) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      bitmap as unknown as ImageBitmap,
      0,
      0,
      size.width,
      size.height,
    );
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, quality),
    );
  } finally {
    // Release the backing store now rather than at collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}

export const browserImaging: Imaging = {
  decode,
  encode: makeEncode(() => document.createElement("canvas")),
};
