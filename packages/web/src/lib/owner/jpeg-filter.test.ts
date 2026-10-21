import { describe, expect, it } from "vitest";
import { keepImageSegments } from "./jpeg-filter";
import { exifApp1, fakeJpeg, segment, spliceAfterSoi, XMP_APP1 } from "./jpeg.test-support";
import { scanJpeg } from "./jpeg-scan";

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const ICC_APP2 = segment(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, ...new Array<number>(40).fill(7)]);
const COM = segment(0xfe, ascii("Made on a canvas"));

/** The markers of a stream, in order, for comparing structure. */
function markers(b: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    const m = b[i + 1] as number;
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) continue;
    out.push(m);
    if (m === 0xd8 || m === 0xd9) continue;
    const len = ((b[i + 2] as number) << 8) | (b[i + 3] as number);
    // Skip the segment's contents. After SOS, the entropy data is walked byte by byte.
    i += 1 + len;
  }
  return out;
}

describe("keepImageSegments", () => {
  it("drops APP1 (EXIF with GPS), APP1 (XMP), APP2 (ICC) and COM, keeping the image's own segments byte for byte", () => {
    const clean = fakeJpeg(1600, 1200);
    const dirty = spliceAfterSoi(fakeJpeg(1600, 1200, [XMP_APP1, ICC_APP2, COM]), exifApp1());
    expect(scanJpeg(dirty).ok).toBe(false);
    const out = keepImageSegments(dirty);
    expect(out).toEqual(clean);
    expect(scanJpeg(out as Uint8Array)).toEqual({ ok: true, width: 1600, height: 1200 });
  });

  it("keeps SOI, APP0/JFIF, DQT, SOF, DHT, DRI, SOS with its data, EOI, in their order", () => {
    const dri = segment(0xdd, [0, 4]);
    const src = fakeJpeg(10, 10, [dri, COM]);
    expect(markers(keepImageSegments(src) as Uint8Array)).toEqual([0xd8, 0xe0, 0xdd, 0xdb, 0xc0, 0xc4, 0xda, 0xd9]);
  });

  it("keeps the entropy-coded data whole: stuffed bytes and restart markers included", () => {
    const entropy = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd3, 0x56, 0xff, 0xd7, 0x78];
    const src = fakeJpeg(10, 10, [COM], { entropy });
    const out = keepImageSegments(src) as Uint8Array;
    expect(Buffer.from(out).includes(Buffer.from(entropy))).toBe(true);
  });

  it("drops an APP0 that is not JFIF", () => {
    const src = fakeJpeg(10, 10, [segment(0xe0, ascii("AVI1xxxx"))]);
    expect(keepImageSegments(src)).toEqual(fakeJpeg(10, 10));
  });

  it("drops anything after EOI", () => {
    expect(keepImageSegments(fakeJpeg(10, 10, [], { trailing: [1, 2, 3, 0xff, 0xd8] }))).toEqual(fakeJpeg(10, 10));
  });

  it("is not where stripping is confirmed: EXIF inside data the filter keeps still reaches the scan, and still fails it", () => {
    const smuggled = fakeJpeg(10, 10, [], { entropy: [1, ...ascii("Exif"), 0, 0, 2] });
    const out = keepImageSegments(smuggled) as Uint8Array;
    expect(out).not.toBeNull();
    expect(scanJpeg(out)).toEqual({ ok: false, finding: "exif" });
  });

  it("answers null for a marker an image might need but this does not keep, rather than dropping it", () => {
    const arithmetic = fakeJpeg(10, 10, [segment(0xcc, [0, 1])]); // DAC
    expect(keepImageSegments(arithmetic)).toBeNull();
    const lossless = fakeJpeg(10, 10, [segment(0xc3, [8, 0, 10, 0, 10, 1, 1, 0x11, 0])]);
    expect(keepImageSegments(lossless)).toBeNull();
  });

  it("answers null for what it cannot parse", () => {
    const good = fakeJpeg(10, 10);
    expect(keepImageSegments(Uint8Array.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(keepImageSegments(good.subarray(0, good.length - 2))).toBeNull();
    expect(keepImageSegments(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toBeNull();
    expect(keepImageSegments(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
