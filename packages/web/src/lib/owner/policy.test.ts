import { describe, expect, it } from "vitest";
import { checkPassword, codePoints, parseBlocklist } from "./policy";
import { KDF_CEILING, withinKdfCeiling } from "$lib/keys/kdf-ceiling";
import { OWNER_KDF_V1 } from "@vitrina/shared";

describe("the owner password policy (brief §12)", () => {
  const list = parseBlocklist("123456789012\r\nPasswordPassword\n\nqwertyuiopasdf\n");

  it("parses one entry per line, CRLF or LF, lowercased, skipping blank lines", () => {
    expect([...list].sort()).toEqual(["123456789012", "passwordpassword", "qwertyuiopasdf"]);
  });

  it("counts Unicode code points, not UTF-16 units", () => {
    expect(codePoints("😀😀")).toBe(2);
    expect(checkPassword("😀".repeat(11), list)).toBe("too-short");
    expect(checkPassword("😀".repeat(12), list)).toBe("ok");
    expect(checkPassword("é".repeat(256), list)).toBe("ok");
    expect(checkPassword("é".repeat(257), list)).toBe("too-long");
  });

  it("has no composition rules: twelve spaces or twelve letters pass", () => {
    expect(checkPassword(" ".repeat(12), list)).toBe("ok");
    expect(checkPassword("abcdefghijkl", list)).toBe("ok");
  });

  it("refuses the blocklist case-insensitively", () => {
    expect(checkPassword("PASSWORDPASSWORD", list)).toBe("common");
    expect(checkPassword("123456789012", list)).toBe("common");
  });

  it("refuses an unpaired surrogate anywhere, and accepts a paired one", () => {
    expect(checkPassword("abcdefghijkl\uD800", list)).toBe("invalid");
    expect(checkPassword("\uDC00abcdefghijkl", list)).toBe("invalid");
    expect(checkPassword("abcdefghijk😀", list)).toBe("ok");
  });
});

describe("the shared Argon2id ceiling", () => {
  it("admits v1, and refuses each bound exceeded", () => {
    expect(withinKdfCeiling(OWNER_KDF_V1)).toBe(true);
    expect(withinKdfCeiling({ memoryKib: KDF_CEILING.maxMemoryKib, iterations: 6, parallelism: 1 })).toBe(true);
    expect(withinKdfCeiling({ memoryKib: KDF_CEILING.maxMemoryKib + 1, iterations: 1, parallelism: 1 })).toBe(false);
    expect(withinKdfCeiling({ memoryKib: 65536, iterations: 3, parallelism: 5 })).toBe(false);
    expect(withinKdfCeiling({ memoryKib: 65536, iterations: 13, parallelism: 1 })).toBe(false);
  });
});

describe("the blocklist as bundled (vite-plugins.ts, filterBlocklist)", async () => {
  const { filterBlocklist } = await import("../../../vite-plugins");
  const raw = ["123456", "passwordpassword\r", "😀".repeat(11), "😀".repeat(12), "x".repeat(256), "x".repeat(257), "", "http://www"].join("\n");

  it("keeps exactly the entries between 12 and 256 code points", () => {
    expect(filterBlocklist(raw).split("\n")).toEqual(["passwordpassword", "😀".repeat(12), "x".repeat(256)]);
  });

  it("changes no outcome: every dropped entry is refused by length before the blocklist is read", () => {
    const full = parseBlocklist(raw);
    const kept = parseBlocklist(filterBlocklist(raw));
    for (const entry of full) expect(checkPassword(entry, kept), JSON.stringify(entry)).toBe(checkPassword(entry, full));
  });
});
