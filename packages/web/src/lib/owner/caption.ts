/*
 * A photo's caption, written at upload (encryption spec §7, `caption`). It
 * travels only inside the metadata envelope, as the filename does.
 *
 * Counted in Unicode code points, as the password policy is (policy.ts): "🛁"
 * is one character to the person typing it, and two UTF-16 units. That is also
 * why the field carries no `maxlength`, which counts UTF-16 units and would
 * stop an emoji-heavy caption at 140.
 *
 * 280 is a client bound, not a format one: it keeps the metadata envelope well
 * inside the relay's 4 KiB cap (api-sketch §9.6) with any filename beside it.
 */
import { codePoints } from "./policy";

export const CAPTION_MAX = 280;
/** The count is shown from here on, so it is there before it matters and not before. */
export const CAPTION_COUNT_FROM = 200;

export type CaptionCheck = "ok" | "too-long" | "invalid";

/** An unpaired UTF-16 surrogate: TextEncoder would silently turn it into U+FFFD. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** What would be stored: the text without surrounding whitespace, or null for none. */
export function captionValue(typed: string): string | null {
  const t = typed.trim();
  return t === "" ? null : t;
}

export const captionLength = (typed: string): number => codePoints(captionValue(typed) ?? "");

export function checkCaption(typed: string): CaptionCheck {
  const v = captionValue(typed);
  if (v === null) return "ok";
  if (LONE_SURROGATE.test(v)) return "invalid";
  return codePoints(v) > CAPTION_MAX ? "too-long" : "ok";
}
