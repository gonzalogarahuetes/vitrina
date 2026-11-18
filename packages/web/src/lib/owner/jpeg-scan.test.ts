import { describe, expect, it } from "vitest";
import { exifApp1, exifApp1LE, fakeJpeg, segment, spliceAfterSoi, XMP_APP1 } from "./jpeg.test-support";
import { exifOrientation, scanJpeg } from "./jpeg-scan";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

describe("scanJpeg (non-negotiables #11 and #17)", () => {
  it("a canvas-shaped JPEG passes and reports its frame size", () => {
    expect(scanJpeg(fakeJpeg(1600, 1200))).toEqual({ ok: true, width: 1600, height: 1200 });
  });

  it("an ICC profile is permitted", () => {
    expect(scanJpeg(fakeJpeg(10, 20, [segment(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, 9, 9])])).ok).toBe(true);
  });

  it("EXIF with GPS, where a phone writes it, is found", () => {
    expect(scanJpeg(spliceAfterSoi(fakeJpeg(10, 10), exifApp1()))).toEqual({ ok: false, finding: "exif" });
  });

  it("an APP1 Exif segment is found by the walk even without the whole-file signature", () => {
    // "Exif\0" then a non-zero byte: the signature search misses it, the structural walk does not.
    expect(scanJpeg(fakeJpeg(10, 10, [segment(0xe1, [...ascii("Exif"), 0, 1, 2, 3])]))).toEqual({ ok: false, finding: "exif" });
  });

  it("XMP is found", () => {
    expect(scanJpeg(fakeJpeg(10, 10, [XMP_APP1])).ok).toBe(false);
    expect(scanJpeg(fakeJpeg(10, 10, [XMP_APP1]))).toMatchObject({ finding: "xmp" });
  });

  it("a GPS tag name anywhere is found, even inside entropy-coded data", () => {
    expect(scanJpeg(fakeJpeg(10, 10, [], { entropy: [1, 2, ...ascii("GPSLongitude"), 3] }))).toEqual({ ok: false, finding: "gps" });
  });

  it("every other APPn, a comment, and an unknown APP1 are findings", () => {
    expect(scanJpeg(fakeJpeg(10, 10, [segment(0xed, ascii("Photoshop 3.0"))]))).toEqual({ ok: false, finding: "app-segment" });
    expect(scanJpeg(fakeJpeg(10, 10, [segment(0xe1, ascii("something"))]))).toEqual({ ok: false, finding: "app-segment" });
    expect(scanJpeg(fakeJpeg(10, 10, [segment(0xe0, ascii("AVI1"))]))).toEqual({ ok: false, finding: "app-segment" });
    expect(scanJpeg(fakeJpeg(10, 10, [segment(0xfe, ascii("hello"))]))).toEqual({ ok: false, finding: "comment" });
  });

  it("bytes after EOI are a finding", () => {
    expect(scanJpeg(fakeJpeg(10, 10, [], { trailing: [0, 1, 2] }))).toEqual({ ok: false, finding: "trailing-data" });
  });

  it("what it cannot parse fails rather than passes", () => {
    const good = fakeJpeg(10, 10);
    expect(scanJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toEqual({ ok: false, finding: "not-jpeg" });
    expect(scanJpeg(good.subarray(0, good.length - 2))).toEqual({ ok: false, finding: "malformed" });
    expect(scanJpeg(good.subarray(0, 30))).toEqual({ ok: false, finding: "malformed" });
    // A segment length that runs past the end.
    expect(scanJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0]))).toEqual({ ok: false, finding: "malformed" });
    // No frame before EOI.
    expect(scanJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toEqual({ ok: false, finding: "malformed" });
  });
});

describe("exifOrientation: which shape a correctly oriented decode has", () => {
  const be = (o: number) => spliceAfterSoi(fakeJpeg(4000, 3000), exifApp1(o));
  const le = (o: number) => fakeJpeg(4000, 3000, [exifApp1LE(o)]);

  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`reads ${o}, big-endian (MM) straight after SOI and little-endian (II) after a JFIF APP0`, () => {
      expect(exifOrientation(be(o))).toBe(o);
      expect(exifOrientation(le(o))).toBe(o);
    });
  }

  it("reads past an XMP APP1 that comes before the Exif one", () => {
    expect(exifOrientation(fakeJpeg(4000, 3000, [XMP_APP1, exifApp1(6)]))).toBe(6);
    expect(exifOrientation(fakeJpeg(4000, 3000, [XMP_APP1, exifApp1LE(8)]))).toBe(8);
  });

  it("is null with no Exif at all, with XMP alone, and for something that is not a JPEG", () => {
    expect(exifOrientation(fakeJpeg(4000, 3000))).toBeNull();
    expect(exifOrientation(fakeJpeg(4000, 3000, [XMP_APP1]))).toBeNull();
    expect(exifOrientation(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
  });

  it("is null for an Exif after the image data starts: there is none to be had", () => {
    const j = fakeJpeg(4000, 3000);
    const eoi = j.length - 2;
    expect(exifOrientation(Uint8Array.from([...j.subarray(0, eoi), ...exifApp1(6), 0xff, 0xd9]))).toBeNull();
  });

  it("is null for 0 and 9, both byte orders", () => {
    for (const o of [0, 9]) {
      expect(exifOrientation(be(o))).toBeNull();
      expect(exifOrientation(le(o))).toBeNull();
    }
  });

  it("is null, not a throw, for a file cut short anywhere in its Exif", () => {
    for (const whole of [be(6), le(6)]) {
      const app1 = whole.findIndex((_, i) => whole[i] === 0xff && whole[i + 1] === 0xe1);
      const end = app1 + 2 + (((whole[app1 + 2] as number) << 8) | (whole[app1 + 3] as number));
      for (let n = 0; n < end; n++) expect(exifOrientation(whole.subarray(0, n)), `cut at ${n}`).toBeNull();
      expect(exifOrientation(whole.subarray(0, end)), "whole, it reads").toBe(6);
    }
  });

  it("is null for a malformed TIFF: wrong byte-order mark, wrong magic, IFD out of range, an IFD that claims more entries than it has, a tag that is not a SHORT", () => {
    // The TIFF header of le(6): "II", 42.
    const tiffAt = (b: Uint8Array) => b.findIndex((_, i) => b[i] === 0x49 && b[i + 1] === 0x49 && b[i + 2] === 42 && b[i + 3] === 0);
    const patch = (at: number, bytes: number[]) => {
      const b = le(6);
      b.set(bytes, tiffAt(b) + at);
      return b;
    };
    expect(exifOrientation(le(6)), "the unpatched file reads").toBe(6);
    expect(exifOrientation(patch(0, [0x49, 0x4d]))).toBeNull(); // "IM"
    expect(exifOrientation(patch(2, [43, 0]))).toBeNull(); // magic 43
    expect(exifOrientation(patch(4, [0xff, 0xff, 0, 0]))).toBeNull(); // IFD0 past the segment
    // Two entries claimed, room for one: the first is another tag, the second (Orientation, if any) runs off the end.
    const short = patch(8, [2, 0]);
    short.set([0x00, 0x01], tiffAt(short) + 10);
    expect(exifOrientation(short)).toBeNull();
    expect(exifOrientation(patch(12, [4, 0]))).toBeNull(); // Orientation as a LONG
  });

  it("is null for a segment whose length runs past the bytes", () => {
    const b = le(6);
    const app1 = b.findIndex((_, i) => b[i] === 0xff && b[i + 1] === 0xe1);
    b[app1 + 2] = 0xff; // the APP1 length's high byte
    expect(exifOrientation(b)).toBeNull();
  });
});
