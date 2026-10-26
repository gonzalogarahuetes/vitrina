/*
 * What the app ships that others made, and the licence each comes under. One
 * entry per file in static/licenses/, served at /licenses/<file> and listed on
 * the /licences screen. licences.test.ts holds the folder and this list to
 * each other, and requires an entry for every passphrase wordlist the loader
 * offers, so a list cannot ship without its attribution.
 */
import type { Copy } from "$lib/copy/en";

export type Licence = {
  /** The file in static/licenses/. */
  readonly file: string;
  /** The copy slot naming what it covers. */
  readonly covers: keyof Copy;
  /** For a passphrase wordlist: its language, as the loader names it. */
  readonly wordlist?: string;
};

export const LICENCES: readonly Licence[] = [
  { file: "OFL-AtkinsonHyperlegible.txt", covers: "licences.font" },
  { file: "EFF-wordlist-CC-BY-4.0.txt", covers: "licences.wordlist.en", wordlist: "en" },
  { file: "es-wordlist-CC-BY-SA-4.0.txt", covers: "licences.wordlist.es", wordlist: "es" },
  { file: "SecLists-MIT.txt", covers: "licences.blocklist" },
];
