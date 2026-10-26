import { describe, expect, it } from "vitest";
import type { Bitmap, Dims, Resize } from "./prepare";
import { PREVIEW_LONG_EDGE, makePreview } from "./preview";

/** A decoder for a photo that is `oriented` once EXIF orientation is applied, honouring the resize or not. */
function rig(oriented: Dims, honour: boolean) {
  const open = new Set<Bitmap>();
  const log: string[] = [];
  const bitmap = (d: Dims, tag: string): Bitmap => {
    const b: Bitmap = {
      ...d,
      close: () => {
        open.delete(b);
        log.push(`close ${tag}`);
      },
    };
    open.add(b);
    return b;
  };
  const decode = async (_f: Blob, r: Resize | null): Promise<Bitmap> => {
    log.push(`decode ${JSON.stringify(r)}`);
    if (!honour || r === null) return bitmap(oriented, "decoded");
    const d = "width" in r ? { width: r.width, height: Math.round((oriented.height * r.width) / oriented.width) } : { width: Math.round((oriented.width * r.height) / oriented.height), height: r.height };
    return bitmap(d, "decoded");
  };
  let largestOpen = 0;
  const shrink = async (_b: Bitmap, size: Dims): Promise<Bitmap> => {
    log.push(`shrink ${size.width}x${size.height}`);
    const s = bitmap(size, "small");
    largestOpen = Math.max(largestOpen, open.size);
    return s;
  };
  return { decode, shrink, open, log, largestOpen: () => largestOpen };
}

const file = new Blob([new Uint8Array([0xff, 0xd8])]);

describe("the review's previews: small, upright, one large bitmap at most, released at once", () => {
  it("a landscape photo whose decode honours the size is kept as decoded", async () => {
    const r = rig({ width: 4032, height: 3024 }, true);
    const p = await makePreview(file, r.decode, r.shrink);
    expect([p.width, p.height]).toEqual([PREVIEW_LONG_EDGE, 360]);
    expect(r.log).toEqual([`decode {"width":${PREVIEW_LONG_EDGE}}`]);
    expect(r.open.size).toBe(1);
  });

  it("a portrait photo comes back taller than wanted: drawn down to preview size, the decoded one closed", async () => {
    const r = rig({ width: 3024, height: 4032 }, true);
    const p = await makePreview(file, r.decode, r.shrink);
    expect([p.width, p.height]).toEqual([360, PREVIEW_LONG_EDGE]);
    expect(r.log).toEqual([`decode {"width":${PREVIEW_LONG_EDGE}}`, `shrink 360x${PREVIEW_LONG_EDGE}`, "close decoded"]);
    expect(r.open.size, "only the preview is left open").toBe(1);
  });

  it("a browser that ignores the size gives a full-size bitmap: drawn down, then closed, never kept", async () => {
    const r = rig({ width: 8000, height: 6000 }, false);
    const p = await makePreview(file, r.decode, r.shrink);
    expect([p.width, p.height]).toEqual([PREVIEW_LONG_EDGE, 360]);
    expect(r.log.at(-1)).toBe("close decoded");
    expect(r.open.size).toBe(1);
    expect(r.largestOpen(), "the full-size bitmap and its small copy, and nothing else").toBe(2);
  });

  it("a failed shrink still closes the decoded bitmap", async () => {
    const r = rig({ width: 8000, height: 6000 }, false);
    await expect(
      makePreview(file, r.decode, async () => {
        throw new Error("no canvas");
      }),
    ).rejects.toThrow();
    expect(r.open.size).toBe(0);
  });

  it("an impossible shape is refused and closed", async () => {
    const r = rig({ width: 0, height: 0 }, false);
    await expect(makePreview(file, r.decode, r.shrink)).rejects.toThrow();
    expect(r.open.size).toBe(0);
  });
});
