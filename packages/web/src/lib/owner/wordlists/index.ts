/*
 * The vetted passphrase wordlists (encryption spec §6.3, brief §15.2). The
 * owner supplies each list as a file in this folder, with its licence beside
 * it, as with the blocklist and the font: nothing is downloaded, here or at
 * build time. `<language>.txt` is the list; `<language>.LICENSE.txt` is its
 * licence. Other files may sit beside them (a build's inputs and checks);
 * only a file named exactly by a language code is a list. Adding a language
 * is adding those two files, and nothing here changes: no code names a
 * language.
 *
 * Only passphrase invite creation reaches this module, through a dynamic
 * import (routes/+page.svelte's loadWordlists), so it is a chunk of its own
 * and loads only when an owner picks passphrase mode. check-build.mjs fails a
 * build where any chunk imports it statically. Bundled rather than fetched
 * because connect-src names the API origin alone.
 *
 * Whether a list meets §6.3's bar (7,776 words, no two normalising alike) is
 * checked at test time by wordlists.test.ts, through the crate's own
 * normalisation. A list that fails it never ships, because the suite is red.
 */
import type { Wordlist } from "$lib/keys/owner-types";

// `!./*.*.txt` keeps licences and a build's side files out of the bundle, not merely out of the list.
const all = import.meta.glob<string>(["./*.txt", "!./*.*.txt"], { query: "?raw", import: "default", eager: true });

/**
 * A list is `<language>.txt` and nothing else: `en.txt`, `es.txt`, `pt-BR.txt`.
 * Every other text file here (a licence, a build's exclusion or review list)
 * has a second dot and is not a wordlist.
 */
export const LIST_FILE = /^\.\/[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?\.txt$/;

const files = Object.fromEntries(Object.entries(all).filter(([path]) => LIST_FILE.test(path)));

/**
 * One word per line. EFF's format (`11111<TAB>abacus`) has its dice column
 * dropped; a plain list is taken as it is. Blank lines are skipped. Nothing
 * else is touched: no case folding, no trimming inside a line, no dedup —
 * the test is what refuses a list that needs any of that.
 */
export function parseWordlist(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .filter((line) => line !== "")
    .map((line) => /^[1-6]+\t(.+)$/.exec(line)?.[1] ?? line);
}

/** `./en.txt` → `en`. */
export function languageOf(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.txt$/, "");
}

export const WORDLISTS: readonly Wordlist[] = Object.entries(files)
  .map(([path, raw]) => ({ language: languageOf(path), words: parseWordlist(raw) }))
  .sort((a, b) => a.language.localeCompare(b.language));

// An empty file would offer a language with nothing to draw from. The message
// is also how check-build.mjs finds this chunk: keep the two in step.
for (const l of WORDLISTS) if (l.words.length === 0) throw new Error(`vitrina:passphrase-wordlists: ${l.language} is empty`);
