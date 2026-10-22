/*
 * JPEG bytes for tests: structurally valid streams (not decodable images) for
 * the scanner, and a real EXIF APP1 segment with an orientation tag and a GPS
 * IFD, for splicing into a real JPEG. The browser check uses the same segment
 * on a JPEG the browser itself encoded, so a phone-shaped file is tested in
 * both places without shipping a photograph in the repository.
 */

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));

export function segment(marker: number, data: readonly number[]): number[] {
  return [0xff, marker, ...u16(data.length + 2), ...data];
}

export const JFIF_APP0 = segment(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

/**
 * APP1 Exif, big-endian TIFF: IFD0 with Orientation and a GPSInfo pointer,
 * and a GPS IFD with latitude N 40° 25' 0" and longitude W 3° 42' 0".
 */
export function exifApp1(orientation = 6): number[] {
  // Offsets are from the start of the TIFF header.
  const ifd0At = 8;
  const ifd0 = 2 + 2 * 12 + 4; // count, two entries, next-IFD
  const gpsAt = ifd0At + ifd0;
  const gpsEntries = 4;
  const gpsIfd = 2 + gpsEntries * 12 + 4;
  const latAt = gpsAt + gpsIfd;
  const lonAt = latAt + 24;
  const entry = (tag: number, type: number, count: number, value: number[]) => [...u16(tag), ...u16(type), ...u32(count), ...value];
  const rationals = (vals: number[]) => vals.flatMap((v) => [...u32(v), ...u32(1)]);
  const tiff = [
    ...ascii("MM"),
    ...u16(42),
    ...u32(ifd0At),
    ...u16(2),
    entry(0x0112, 3, 1, [...u16(orientation), 0, 0]),
    entry(0x8825, 4, 1, u32(gpsAt)),
    ...u32(0),
    ...u16(gpsEntries),
    entry(0x0001, 2, 2, [...ascii("N"), 0, 0, 0]),
    entry(0x0002, 5, 3, u32(latAt)),
    entry(0x0003, 2, 2, [...ascii("W"), 0, 0, 0]),
    entry(0x0004, 5, 3, u32(lonAt)),
    ...u32(0),
    ...rationals([40, 25, 0]),
    ...rationals([3, 42, 0]),
  ].flat();
  return segment(0xe1, [...ascii("Exif"), 0, 0, ...tiff]);
}

export const XMP_APP1 = segment(0xe1, [...ascii("http://ns.adobe.com/xap/1.0/"), 0, ...ascii('<x:xmpmeta xmlns:x="adobe:ns:meta/"><exif:GPSLatitude>40,25N</exif:GPSLatitude></x:xmpmeta>')]);

/**
 * An EXIF signature and GPS tag names inside entropy-coded data: where the
 * filter keeps everything, so only the scan can catch them. No 0xFF byte, so
 * the stream stays parseable.
 */
export const HIDDEN_EXIF = [0x12, ...ascii("Exif"), 0, 0, ...ascii("GPSLatitude GPSLongitude"), 0x34];

/** A structurally valid baseline JPEG stream of the given frame size, with `extra` segments after APP0. */
export function fakeJpeg(width: number, height: number, extra: readonly number[][] = [], opts: { trailing?: number[]; entropy?: number[] } = {}): Uint8Array<ArrayBuffer> {
  const dqt = segment(0xdb, [0, ...new Array<number>(64).fill(1)]);
  const sof = segment(0xc0, [8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const dht = segment(0xc4, [0, ...new Array<number>(16).fill(0)]);
  const sos = segment(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0]);
  // Entropy-coded data with a stuffed 0xFF00 and a restart marker, as real streams have.
  const entropy = opts.entropy ?? [0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78, 0x9a];
  return Uint8Array.from([0xff, 0xd8, ...JFIF_APP0, ...extra.flat(), ...dqt, ...sof, ...dht, ...sos, ...entropy, 0xff, 0xd9, ...(opts.trailing ?? [])]);
}

/** `jpeg` with `seg` inserted straight after SOI, as a camera writes its APP1. */
export function spliceAfterSoi(jpeg: Uint8Array, seg: readonly number[]): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([jpeg[0] ?? 0, jpeg[1] ?? 0, ...seg, ...jpeg.subarray(2)]);
}
