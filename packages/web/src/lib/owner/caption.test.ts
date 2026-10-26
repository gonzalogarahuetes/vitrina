import { describe, expect, it } from "vitest";
import { CAPTION_MAX, captionLength, captionValue, checkCaption } from "./caption";

describe("captions (encryption spec §7): at most 280 code points, as the password policy counts", () => {
  it("counts code points, not UTF-16 units", () => {
    const bath = "🛁";
    expect(bath.length).toBe(2);
    expect(captionLength(bath.repeat(280))).toBe(280);
    expect(checkCaption(bath.repeat(280))).toBe("ok");
    expect(checkCaption(bath.repeat(281))).toBe("too-long");
    expect(checkCaption("a".repeat(CAPTION_MAX))).toBe("ok");
    expect(checkCaption("a".repeat(CAPTION_MAX + 1))).toBe("too-long");
    // Combining marks are code points of their own: "é" as e + U+0301 is two.
    expect(captionLength("é")).toBe(2);
  });

  it("surrounding whitespace is not stored and not counted; only whitespace is no caption", () => {
    expect(captionValue("  hola \n")).toBe("hola");
    expect(captionValue(" \n\t")).toBeNull();
    expect(captionLength(`   ${"a".repeat(CAPTION_MAX)}   `)).toBe(CAPTION_MAX);
    expect(checkCaption(`   ${"a".repeat(CAPTION_MAX)}   `)).toBe("ok");
    expect(checkCaption("")).toBe("ok");
  });

  it("refuses a lone surrogate, which TextEncoder would silently turn into U+FFFD", () => {
    expect(checkCaption("abc\uD83D")).toBe("invalid");
    expect(checkCaption("\uDC00abc")).toBe("invalid");
    expect(checkCaption("abc🛁")).toBe("ok");
  });
});
