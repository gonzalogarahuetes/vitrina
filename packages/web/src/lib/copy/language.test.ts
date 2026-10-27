/*
 * How the interface language is chosen, and that every screen reads it: the
 * first of the device's languages the app has (brief §15.1 forbids guessing
 * from the network, not this), and no app module bypassing the current
 * language by importing one language's copy directly.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPY, FALLBACK, FORMAT, LANGUAGES, firstSupported } from "./index";

describe("the first interface language", () => {
  it("is the first of navigator.languages the app has, by primary subtag", () => {
    expect(firstSupported(["es-ES"])).toBe("es");
    expect(firstSupported(["es-MX", "en-US"])).toBe("es");
    expect(firstSupported(["ca-ES", "es-ES", "en"])).toBe("es");
    expect(firstSupported(["en-GB", "es"])).toBe("en");
    expect(firstSupported(["ES"])).toBe("es");
    expect(firstSupported(["fr-FR", "de"])).toBe(FALLBACK);
    expect(firstSupported([])).toBe(FALLBACK);
  });

  it("falls back to English, the reference text (brief §16)", () => {
    expect(FALLBACK).toBe("en");
  });

  it("every language has its copy and its formats", () => {
    for (const l of LANGUAGES) {
      expect(COPY[l], l).toBeDefined();
      expect(FORMAT[l], l).toBeDefined();
    }
  });
});

describe("every screen reads the current language", () => {
  const SRC = fileURLToPath(new URL("../..", import.meta.url));
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const app = files(SRC).filter((f) => /\.(svelte|ts)$/.test(f) && !/\.test(-support)?\.ts$/.test(f) && !f.startsWith(join(SRC, "lib/copy/")));

  it("no app module imports one language's copy or formats as values: only copy() and format() choose", () => {
    const offenders = app.filter((f) => {
      const text = readFileSync(f, "utf8");
      return [...text.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"\$lib\/copy\/(en|es)"/g)].some(([, isType, names]) => isType === undefined && (names ?? "").split(",").some((n) => !/^\s*type\s/.test(n) && n.trim() !== ""));
    });
    expect(offenders.map((f) => f.slice(SRC.length))).toEqual([]);
    expect(app.length).toBeGreaterThan(20);
  });

  it("the language choice touches no storage: nothing in lib/copy names a storage API", () => {
    const copyDir = join(SRC, "lib/copy");
    for (const f of readdirSync(copyDir).filter((n) => !/\.test\.ts$/.test(n))) {
      expect(readFileSync(join(copyDir, f), "utf8"), f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|cookieStore/);
    }
  });
});
