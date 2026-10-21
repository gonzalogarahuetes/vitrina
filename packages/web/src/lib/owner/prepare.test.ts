import { describe, expect, it } from "vitest";
import { jpegFrameSize } from "./jpeg-scan";
import { exifApp1, fakeJpeg, HIDDEN_EXIF, segment, spliceAfterSoi } from "./jpeg.test-support";
import { CHUNK_SIZE, fitLongEdge, prepare, type Bitmap, type Dims, type Imaging, type Resize } from "./prepare";

type Opts = {
  /** What a full decode yields: the photo with its EXIF orientation applied. */
  oriented?: Dims;
  /** The stored frame, as the file's SOF says. Default: `oriented` turned a quarter, as phones store portraits. */
  frame?: Dims | null;
  /** How decode treats a resize: honour it after orienting (default), ignore it, apply it before orienting, or throw. */
  decode?: "honour" | "ignore" | "before-orienting" | "throw";
  encode?: (size: Dims, call: number) => Blob | null;
};

function fakeImaging(opts: Opts = {}) {
  const oriented = opts.oriented ?? { width: 3024, height: 4032 };
  const frame = opts.frame === undefined ? { width: oriented.height, height: oriented.width } : opts.frame;
  const log: string[] = [];
  const open = new Set<Bitmap>();
  const bitmap = (d: Dims): Bitmap => {
    const b: Bitmap = {
      width: d.width,
      height: d.height,
      close: () => {
        log.push(`close ${d.width}x${d.height}`);
        open.delete(b);
      },
    };
    if (open.size > 0) throw new Error("two bitmaps open at once");
    open.add(b);
    return b;
  };
  const scale = (d: Dims, r: Resize): Dims =>
    "width" in r ? { width: r.width, height: Math.round((d.height * r.width) / d.width) } : { width: Math.round((d.width * r.height) / d.height), height: r.height };
  let calls = 0;
  const imaging: Imaging = {
    decode: async (_f, r) => {
      log.push(`decode ${r === null ? "full" : "width" in r ? `width ${r.width}` : `height ${r.height}`}`);
      const mode = opts.decode ?? "honour";
      if (mode === "throw") throw new Error("out of memory");
      if (r === null || mode === "ignore") return bitmap(oriented);
      if (mode === "before-orienting" && frame !== null) {
        const s = scale(frame, r);
        const rotated = frame.width !== oriented.width;
        return bitmap(rotated ? { width: s.height, height: s.width } : s);
      }
      return bitmap(scale(oriented, r));
    },
    encode: async (b, size, type, quality) => {
      log.push(`encode ${size.width}x${size.height} from ${b.width}x${b.height} ${type} ${quality}`);
      if (!open.has(b)) throw new Error("drew a closed bitmap");
      const call = calls++;
      if (opts.encode !== undefined) return opts.encode(size, call);
      return new Blob([fakeJpeg(size.width, size.height)], { type: "image/jpeg" });
    },
  };
  const file = (name = "IMG_20260612_bathtime.jpg") =>
    new File([frame === null ? new Uint8Array([1, 2, 3]) : spliceAfterSoi(fakeJpeg(frame.width, frame.height), exifApp1())], name, { type: "image/jpeg" });
  return { imaging, log, open, file };
}

const meta = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

describe("fitLongEdge (#14)", () => {
  it("brings the long edge down to the limit, keeping the aspect", () => {
    expect(fitLongEdge({ width: 4000, height: 3000 }, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(fitLongEdge({ width: 3000, height: 4000 }, 1600)).toEqual({ width: 1200, height: 1600 });
  });
  it("never upscales", () => {
    expect(fitLongEdge({ width: 800, height: 600 }, 1600)).toEqual({ width: 800, height: 600 });
    expect(fitLongEdge({ width: 1600, height: 900 }, 1600)).toEqual({ width: 1600, height: 900 });
  });
  it("never rounds an edge to zero", () => {
    expect(fitLongEdge({ width: 10000, height: 2 }, 1600)).toEqual({ width: 1600, height: 1 });
  });
});

describe("jpegFrameSize", () => {
  it("reads the stored frame past a camera's EXIF segment, without reading EXIF", () => {
    expect(jpegFrameSize(spliceAfterSoi(fakeJpeg(4032, 3024), exifApp1()))).toEqual({ width: 4032, height: 3024 });
  });
  it("is null for anything that is not a JPEG", () => {
    expect(jpegFrameSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});

describe("prepare (flows §3.6 step 1)", () => {
  it("a phone portrait: decoded once at the target width, found portrait, decoded at the target height; both JPEGs drawn from that", async () => {
    const f = fakeImaging();
    const r = await prepare(f.file(), f.imaging);
    expect(r.ok).toBe(true);
    expect(f.log).toEqual([
      "decode width 1600",
      "close 1600x2133",
      "decode height 1600",
      "encode 1200x1600 from 1200x1600 image/jpeg 0.85",
      "encode 360x480 from 1200x1600 image/jpeg 0.8",
      "close 1200x1600",
    ]);
    expect(f.open.size).toBe(0);
  });

  it("a landscape photo: one downscaled decode", async () => {
    const f = fakeImaging({ oriented: { width: 4000, height: 3000 }, frame: { width: 4000, height: 3000 } });
    expect((await prepare(f.file(), f.imaging)).ok).toBe(true);
    expect(f.log.slice(0, 2)).toEqual(["decode width 1600", "encode 1600x1200 from 1600x1200 image/jpeg 0.85"]);
  });

  it("the metadata is encryption spec §7 exactly: the oriented dimensions as encrypted and the original filename, no taken_at", async () => {
    const f = fakeImaging();
    const r = await prepare(f.file(), f.imaging);
    if (!r.ok) throw new Error(r.error);
    expect(meta(r.prepared.meta)).toEqual({ width: 1200, height: 1600, name: "IMG_20260612_bathtime.jpg" });
    expect(r.prepared.size).toEqual({ width: 1200, height: 1600 });
  });

  it("a small photo is decoded whole, not upscaled, and still re-encoded", async () => {
    const f = fakeImaging({ oriented: { width: 640, height: 480 }, frame: { width: 640, height: 480 } });
    const r = await prepare(f.file(), f.imaging);
    if (!r.ok) throw new Error(r.error);
    expect(f.log).toEqual(["decode full", "encode 640x480 from 640x480 image/jpeg 0.85", "encode 480x360 from 640x480 image/jpeg 0.8", "close 640x480"]);
    expect(meta(r.prepared.meta)).toMatchObject({ width: 640, height: 480 });
  });

  it("a photo smaller than a thumbnail is not upscaled either", async () => {
    const f = fakeImaging({ oriented: { width: 300, height: 200 }, frame: { width: 300, height: 200 } });
    expect((await prepare(f.file(), f.imaging)).ok).toBe(true);
    expect(f.log).toContain("encode 300x200 from 300x200 image/jpeg 0.8");
  });

  it("a browser that ignores the resize: the full-size bitmap is drawn down, and only one is open at a time", async () => {
    const f = fakeImaging({ decode: "ignore" });
    const r = await prepare(f.file(), f.imaging);
    if (!r.ok) throw new Error(r.error);
    expect(meta(r.prepared.meta), "the size as encrypted, not as decoded").toMatchObject({ width: 1200, height: 1600 });
    expect(f.log).toEqual([
      "decode width 1600",
      "close 3024x4032",
      "decode height 1600",
      "close 3024x4032",
      "decode full",
      "encode 1200x1600 from 3024x4032 image/jpeg 0.85",
      "encode 360x480 from 3024x4032 image/jpeg 0.8",
      "close 3024x4032",
    ]);
  });

  it("a browser that resizes before orienting: its wrong-shaped bitmap is closed and the photo decoded whole", async () => {
    const f = fakeImaging({ decode: "before-orienting" });
    const r = await prepare(f.file(), f.imaging);
    if (!r.ok) throw new Error(r.error);
    expect(f.log).toContain("decode full");
    expect(r.prepared.size).toEqual({ width: 1200, height: 1600 });
    expect(f.open.size).toBe(0);
  });

  it("a full decode that is not the stored frame's shape, either way round, fails: never a squashed photo", async () => {
    const f = fakeImaging({ oriented: { width: 3000, height: 3000 }, frame: { width: 4000, height: 3000 } });
    expect(await prepare(f.file(), f.imaging)).toEqual({ ok: false, error: "not-decoded" });
    expect(f.log.some((l) => l.startsWith("encode"))).toBe(false);
    expect(f.open.size).toBe(0);
  });

  it("a file with no readable frame (HEIC, PNG) is decoded whole", async () => {
    const f = fakeImaging({ oriented: { width: 4032, height: 3024 }, frame: null });
    expect((await prepare(f.file("IMG_0001.HEIC"), f.imaging)).ok).toBe(true);
    expect(f.log[0]).toBe("decode full");
  });

  it("a decode that throws (out of memory, an unsupported format) fails the item", async () => {
    const f = fakeImaging({ decode: "throw" });
    expect(await prepare(f.file(), f.imaging)).toEqual({ ok: false, error: "not-decoded" });
  });

  it("toBlob's silent PNG is refused, and so is a null blob", async () => {
    const png = fakeImaging({ encode: (s) => new Blob([fakeJpeg(s.width, s.height)], { type: "image/png" }) });
    expect(await prepare(png.file(), png.imaging)).toEqual({ ok: false, error: "not-encoded" });
    expect(png.open.size).toBe(0);
    const none = fakeImaging({ encode: () => null });
    expect(await prepare(none.file(), none.imaging)).toEqual({ ok: false, error: "not-encoded" });
  });

  it("bytes that are not a JPEG, labelled image/jpeg, are refused", async () => {
    const f = fakeImaging({ encode: () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/jpeg" }) });
    expect(await prepare(f.file(), f.imaging)).toMatchObject({ ok: false, error: "not-encoded" });
  });

  it("an output of the wrong size is refused", async () => {
    const f = fakeImaging({ encode: (s) => new Blob([fakeJpeg(s.width * 2, s.height * 2)], { type: "image/jpeg" }) });
    expect(await prepare(f.file(), f.imaging)).toEqual({ ok: false, error: "not-encoded" });
  });

  // ── The filter and the scan, each a guard of its own ──────────────────
  // Segments a browser adds are removed by the filter; EXIF where the filter
  // keeps everything (the image data) can only be caught by the scan.

  it("the scan: EXIF and GPS hidden in the asset's image data fail the item (#17); nothing is returned for upload", async () => {
    const f = fakeImaging({ encode: (s) => new Blob([fakeJpeg(s.width, s.height, [], { entropy: HIDDEN_EXIF })], { type: "image/jpeg" }) });
    expect(await prepare(f.file(), f.imaging)).toEqual({ ok: false, error: "not-stripped", finding: "exif" });
    expect(f.open.size).toBe(0);
  });

  it("the scan: EXIF hidden in the thumbnail's image data alone fails the item too", async () => {
    const f = fakeImaging({
      encode: (s, call) => new Blob([fakeJpeg(s.width, s.height, [], call === 1 ? { entropy: HIDDEN_EXIF } : {})], { type: "image/jpeg" }),
    });
    expect(await prepare(f.file(), f.imaging)).toEqual({ ok: false, error: "not-stripped", finding: "exif" });
  });

  it("the filter: an APP1 (EXIF and GPS), an ICC profile, a comment and trailing bytes the encoder added are removed, and the photo goes through", async () => {
    const icc = segment(0xe2, [..."ICC_PROFILE"].map((c) => c.charCodeAt(0)).concat([0, 1, 1, 9]));
    const com = segment(0xfe, [0x68, 0x69]);
    const f = fakeImaging({
      encode: (s) => new Blob([spliceAfterSoi(fakeJpeg(s.width, s.height, [icc, com], { trailing: [1, 2, 3] }), exifApp1())], { type: "image/jpeg" }),
    });
    const r = await prepare(f.file(), f.imaging);
    if (!r.ok) throw new Error(r.error);
    expect(r.prepared.asset).toEqual(fakeJpeg(1200, 1600));
    expect(r.prepared.thumb).toEqual(fakeJpeg(360, 480));
  });

  it("a thumbnail of exactly one chunk passes; one byte over fails (api-sketch §11.3)", async () => {
    const sized = (n: number) => (s: Dims, call: number) => {
      const j = fakeJpeg(s.width, s.height);
      if (call === 0) return new Blob([j], { type: "image/jpeg" });
      const out = new Uint8Array(n);
      out.set(j.subarray(0, j.length - 2));
      out.fill(0x11, j.length - 2, n - 2); // more entropy-coded data, then EOI
      out[n - 2] = 0xff;
      out[n - 1] = 0xd9;
      return new Blob([out], { type: "image/jpeg" });
    };
    const one = fakeImaging({ encode: sized(CHUNK_SIZE) });
    expect((await prepare(one.file(), one.imaging)).ok).toBe(true);
    const over = fakeImaging({ encode: sized(CHUNK_SIZE + 1) });
    expect(await prepare(over.file(), over.imaging)).toEqual({ ok: false, error: "thumb-too-large" });
  });

  it("an empty filename is left out; one that would overflow the metadata cap fails the item", async () => {
    const f = fakeImaging();
    const r = await prepare(f.file(""), f.imaging);
    if (!r.ok) throw new Error(r.error);
    expect(meta(r.prepared.meta)).toEqual({ width: 1200, height: 1600 });
    expect(await prepare(f.file("x".repeat(5000)), f.imaging)).toEqual({ ok: false, error: "meta-too-large" });
  });
});
