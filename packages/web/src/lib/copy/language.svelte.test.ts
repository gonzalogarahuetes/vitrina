/*
 * The language state itself: it starts from navigator.languages, puts the
 * language on <html lang> at once and on every switch, and switching changes
 * what copy() and format() return. A fresh module per test, because the
 * starting language is read once, when the module loads (so its copy objects
 * are fresh too, and are compared by content).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { en, enFormat } from "./en";
import { es, esFormat } from "./es";

async function load(languages: readonly string[]) {
  const documentElement = { lang: "en" };
  vi.stubGlobal("document", { documentElement });
  vi.stubGlobal("navigator", { languages, language: languages[0] ?? "" });
  vi.resetModules();
  const mod = await import("./language.svelte");
  return { mod, documentElement };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the interface language for this visit", () => {
  it("starts from the device's languages, and sets <html lang> before anything renders", async () => {
    const { mod, documentElement } = await load(["es-ES", "en"]);
    expect(mod.language.current).toBe("es");
    expect(documentElement.lang).toBe("es");
    expect(mod.copy()["onboarding.text"]).toEqual(es["onboarding.text"]);
    expect(mod.format().locale).toBe(esFormat.locale);
  });

  it("a switch changes the copy, the formats and <html lang> together", async () => {
    const { mod, documentElement } = await load(["es"]);
    mod.language.set("en");
    expect(mod.language.current).toBe("en");
    expect(documentElement.lang).toBe("en");
    expect(mod.copy()["onboarding.text"]).toEqual(en["onboarding.text"]);
    expect(mod.format().locale).toBe(enFormat.locale);
  });

  it("the watermark line and the invite's example are written in the current language", async () => {
    const { mod } = await load(["es-ES"]);
    const at = new Date(2026, 7, 6);
    expect(mod.watermarkLine("María", at)).toBe(`María · ${esFormat.watermarkDate(at)}`);
    expect(mod.watermarkExample()).toBe(mod.watermarkLine("María", at));
    mod.language.set("en");
    expect(mod.watermarkLine("María", at)).toBe("María · 6 Aug 2026");
  });

  it("a device with no language the app has starts in English", async () => {
    const { mod, documentElement } = await load(["fr-FR"]);
    expect(mod.language.current).toBe("en");
    expect(documentElement.lang).toBe("en");
  });
});
