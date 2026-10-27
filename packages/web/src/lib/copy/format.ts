/*
 * Dates, numbers and plurals, through Intl and never assembled by hand. Each
 * language's copy module builds its Format from these with its own locale tag,
 * so a date inside a Spanish screen is a Spanish date, the watermark's included.
 */

/** What every interface language supplies beside its copy. */
export type Format = {
  /** The locale every Intl call in this language uses. */
  readonly locale: string;
  /** The watermark's date (brief §5): "6 Aug 2026". */
  watermarkDate(d: Date): string;
  /** For session.ending, in the device's time zone. */
  sessionEndTime(d: Date): string;
  /** For upload.stalled: a rounded duration in words, never below a minute. */
  stuckFor(ms: number): string;
  /** For upload.stalled: the time today, otherwise the day and time. */
  stuckSince(d: Date, now: Date): string;
  /** For the access log and people.revoked. */
  logTime(d: Date, now: Date): string;
  /** For log.summary.last: the day, with the year when it isn't this one. */
  logDay(d: Date, now: Date): string;
  /** A passphrase language's name as it reads inside a sentence: "Spanish", "español". Falls back to the code. */
  languageName(code: string): string;
  /** The same name as it stands alone in a list: "Spanish", "Español". */
  languageLabel(code: string): string;
  /** The countdown for credential.paused, rounded up, never "0". */
  pauseLeft(ms: number): string;
};

/** A number as the locale writes it: "1,234" in English, "12.345" in Spanish. */
export function number(locale: string, n: number): string {
  return new Intl.NumberFormat(locale).format(n);
}

type Forms = Partial<Record<Intl.LDMLPluralRule, (n: string) => string>> & { readonly other: (n: string) => string };

/** The plural form Intl.PluralRules picks for `n`, given `n` formatted for the locale. Falls back to `other`. */
export function plural(locale: string, n: number, forms: Forms): string {
  // Intl would read `false` as 0 and `"3"` as 3: a count that is not a number is a bug, not a plural.
  if (typeof n !== "number") throw new TypeError("plural: not a number");
  const form = forms[new Intl.PluralRules(locale).select(n)] ?? forms.other;
  return form(number(locale, n));
}

/** Upper-cases the first letter as the locale does: "español" → "Español". */
export function capitalise(locale: string, s: string): string {
  const first = s.codePointAt(0);
  if (first === undefined) return s;
  const head = String.fromCodePoint(first);
  return head.toLocaleUpperCase(locale) + s.slice(head.length);
}

/** A language's own name for itself, for the language switcher: "English", "Español". */
export function autonym(code: string): string {
  try {
    return capitalise(code, new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code);
  } catch {
    return code;
  }
}

const dtf = (locale: string, opts: Intl.DateTimeFormatOptions, d: Date): string => new Intl.DateTimeFormat(locale, opts).format(d);

/** The Format members that are pure Intl: the same shapes in every language, written in each one's own way. */
export function intlFormat(locale: string): Omit<Format, "stuckFor" | "pauseLeft"> {
  const name = (code: string): string => {
    try {
      return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    } catch {
      return code;
    }
  };
  const time: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
  const dayTime: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return {
    locale,
    watermarkDate: (d) => dtf(locale, { day: "numeric", month: "short", year: "numeric" }, d),
    sessionEndTime: (d) => dtf(locale, dayTime, d),
    stuckSince: (d, now) => dtf(locale, d.toDateString() === now.toDateString() ? time : dayTime, d),
    logTime: (d, now) => {
      if (d.toDateString() === now.toDateString()) return dtf(locale, time, d);
      return dtf(locale, d.getFullYear() === now.getFullYear() ? dayTime : { day: "numeric", month: "short", year: "numeric", ...time }, d);
    },
    logDay: (d, now) => dtf(locale, d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" }, d),
    languageName: name,
    languageLabel: (code) => capitalise(locale, name(code)),
  };
}
