/*
 * The encode step's colour-space check, run through the real makeEncode with
 * a fake canvas. Decoding has no unit test here: it is the browser's.
 */
import { describe, expect, it } from "vitest";
import { makeEncode, reportsOtherColorSpace, type EncodeCanvas } from "./imaging";
import { fakeJpeg } from "./jpeg.test-support";
import { prepare, type Bitmap } from "./prepare";

type Reported = { colorSpace?: unknown } | "no-method";

function fakeCanvas(reported: Reported) {
  const log: string[] = [];
  const settings: CanvasRenderingContext2DSettings[] = [];
  const make = (): EncodeCanvas => {
    const canvas: EncodeCanvas = {
      width: 0,
      height: 0,
      getContext: (_kind, s) => {
        settings.push(s);
        const ctx = {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          drawImage: () => void log.push("drawImage"),
          ...(reported === "no-method" ? {} : { getContextAttributes: () => reported }),
        };
        return ctx as unknown as CanvasRenderingContext2D;
      },
      toBlob: (cb, type) => {
        log.push(`toBlob ${type}`);
        cb(new Blob([fakeJpeg(canvas.width, canvas.height)], { type: "image/jpeg" }));
      },
    };
    return canvas;
  };
  return { encode: makeEncode(make), log, settings };
}

const bitmap: Bitmap = { width: 800, height: 600, close: () => undefined };

describe("reportsOtherColorSpace", () => {
  it("only a reported value other than srgb is a mismatch", () => {
    expect(reportsOtherColorSpace({ getContextAttributes: () => ({ colorSpace: "display-p3" }) })).toBe(true);
    expect(reportsOtherColorSpace({ getContextAttributes: () => ({ colorSpace: "rec2100-pq" }) })).toBe(true);
    expect(reportsOtherColorSpace({ getContextAttributes: () => ({ colorSpace: "srgb" }) })).toBe(false);
    expect(reportsOtherColorSpace({ getContextAttributes: () => ({}) })).toBe(false);
    expect(reportsOtherColorSpace({})).toBe(false);
  });
});

describe("encode's colour space", () => {
  it("asks for an sRGB context", async () => {
    const c = fakeCanvas({ colorSpace: "srgb" });
    await c.encode(bitmap, { width: 800, height: 600 }, "image/jpeg", 0.85);
    expect(c.settings).toEqual([{ colorSpace: "srgb" }]);
  });

  it("reported srgb: encodes", async () => {
    const c = fakeCanvas({ colorSpace: "srgb" });
    expect(await c.encode(bitmap, { width: 800, height: 600 }, "image/jpeg", 0.85)).not.toBeNull();
    expect(c.log).toEqual(["drawImage", "toBlob image/jpeg"]);
  });

  it("colorSpace absent from the attributes (a browser that predates it): accepted, encodes", async () => {
    const c = fakeCanvas({});
    expect(await c.encode(bitmap, { width: 800, height: 600 }, "image/jpeg", 0.85)).not.toBeNull();
  });

  it("no getContextAttributes at all: accepted, encodes", async () => {
    const c = fakeCanvas("no-method");
    expect(await c.encode(bitmap, { width: 800, height: 600 }, "image/jpeg", 0.85)).not.toBeNull();
  });

  it("reported display-p3: nothing is drawn or encoded", async () => {
    const c = fakeCanvas({ colorSpace: "display-p3" });
    expect(await c.encode(bitmap, { width: 800, height: 600 }, "image/jpeg", 0.85)).toBeNull();
    expect(c.log).toEqual([]);
  });

  it("through prepare: display-p3 fails the item; absent passes it", async () => {
    const decode = async (): Promise<Bitmap> => ({ ...bitmap });
    const file = new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" });
    const p3 = fakeCanvas({ colorSpace: "display-p3" });
    expect(await prepare(file, { decode, encode: p3.encode })).toEqual({ ok: false, error: "not-encoded" });
    const old = fakeCanvas({});
    expect((await prepare(file, { decode, encode: old.encode })).ok).toBe(true);
  });
});
