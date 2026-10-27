/*
 * The interface language for this visit, held in memory and nowhere else
 * (decided 26 October 2026: a manual switch is not remembered between visits).
 * Every screen reads its copy through copy() and format(), so a switch
 * re-renders whatever is on screen, the watermark's date included.
 */
import { COPY, FORMAT, firstSupported, type Language } from "./index";
import { WATERMARK_EXAMPLE, type Copy } from "./en";
import type { Format } from "./format";

function deviceLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

/** `<html lang>` follows the interface language, so a screen reader pronounces the page in it. */
function applyToDocument(l: Language): void {
  if (typeof document !== "undefined") document.documentElement.lang = l;
}

const state = $state<{ current: Language }>({ current: firstSupported(deviceLanguages()) });
applyToDocument(state.current);

export const language = {
  get current(): Language {
    return state.current;
  },
  set(next: Language): void {
    state.current = next;
    applyToDocument(next);
  },
};

/** The current language's copy. Reactive: read it inside $derived or markup. */
export function copy(): Copy {
  return COPY[state.current];
}

/** The current language's dates, numbers and plurals. Reactive, as copy() is. */
export function format(): Format {
  return FORMAT[state.current];
}

/**
 * The watermark's one line (brief §5): the label and the day, in the current
 * language. Called by the recipient session, which draws it into pixels; never
 * put in markup (render.test.ts).
 */
export function watermarkLine(label: string, at: Date): string {
  return copy().watermark(label, format().watermarkDate(at));
}

/** invite.name.hint's example: the watermark exactly as it would be drawn. Reactive. */
export function watermarkExample(): string {
  return watermarkLine(WATERMARK_EXAMPLE.label, WATERMARK_EXAMPLE.date);
}
