/*
 * The interface languages, and how the first one is chosen. Brief §15.1: an
 * explicit setting, never inferred from IP geolocation. The start is the
 * person's own device setting, navigator.languages; the switcher on every
 * screen changes it for this visit only. Nothing about the choice is stored
 * (eslint.config.js): a reload starts from the device setting again.
 *
 * A language is listed here only once a fluent reader has signed off on its
 * brief §16 text (brief §15.3).
 */
import { en, enFormat, type Copy } from "./en";
import { es, esFormat } from "./es";
import type { Format } from "./format";

export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];

/** Used when the device names no language this app has. English is the reference text (brief §16). */
export const FALLBACK: Language = "en";

export const COPY: Readonly<Record<Language, Copy>> = { en, es };
export const FORMAT: Readonly<Record<Language, Format>> = { en: enFormat, es: esFormat };

export function isLanguage(code: string): code is Language {
  return (LANGUAGES as readonly string[]).includes(code);
}

/** The first of the device's languages that this app has, by its primary subtag: "es-MX" → es. */
export function firstSupported(preferred: readonly string[]): Language {
  for (const tag of preferred) {
    const primary = tag.toLowerCase().split(/[-_]/)[0] ?? "";
    if (isLanguage(primary)) return primary;
  }
  return FALLBACK;
}
