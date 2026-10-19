import { describe, expect, it } from "vitest";
import { exifApp1, fakeJpeg, segment, spliceAfterSoi, XMP_APP1 } from "./jpeg.test-support";
import { scanJpeg } from "./jpeg-scan";

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
