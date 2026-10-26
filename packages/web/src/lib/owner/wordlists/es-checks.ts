/*
 * The automated checks on the Spanish passphrase wordlist (es.txt), shared by
 * the build script (scripts/build-wordlist-es.mjs) and the test that re-runs
 * them on the committed file (es.test.ts). Everything here is pure string
 * work on the words as spelled. Nothing here normalises: §6.3's normalisation
 * is the crate's, reached through the envelope binding, and this module must
 * never grow a copy of it.
 *
 * Encryption spec §6.3 sets the bar (≥ 7,776 words, no homophones, no pairs
 * that normalise identically); brief §15.2 forbids offering a language without
 * a list that clears it. The checks beyond §6.3 — length, spelling from
 * hearing, near-duplicates — exist because the words are read aloud over the
 * phone and written down by hand.
 */

/** The diceware count: five words ≈ 64.6 bits, and §6.3's minimum. */
export const LIST_SIZE = 7776;

/*
 * The file the build writes and the test checks. While a list is under
 * review it is built under a name the loader ignores (`es.txt.candidate`:
 * index.ts offers only `<language>.txt`), so Spanish cannot be offered from
 * an unfinished list. It became `es.txt` on 23 October 2026, after the owner
 * read every word (brief §15.3). A rebuild that changes the words goes back
 * through that review: set this to the candidate name, build, review, rename.
 */
export const LIST_FILE_NAME = "es.txt";

/** Letters per word, counted in code points of the NFC form (ñ, á count once). */
export const MIN_LETTERS = 3;
export const MAX_LETTERS = 8;

/*
 * Lowercase Spanish letters only. No k and no w: both occur in Spanish solely
 * in loanwords whose spelling is unsettled (kiosco/quiosco, whisky/güisqui),
 * and a passphrase word must have one spelling. No digits, hyphens, spaces
 * or apostrophes.
 */
export const LETTERS = /^[a-jl-vx-zñáéíóúü]+$/u;

export function letterCount(word: string): number {
  return [...word].length;
}

/* ── Homophones ─────────────────────────────────────────────────────────── */

/*
 * A pronunciation key: two words with the same key sound the same to some
 * large group of Spanish speakers, so at most one of them may be in the list.
 *
 * Rules applied, each merging a distinction that is absent in at least one
 * major variety, so the list is safe for all of them:
 *   - accents are dropped (they are also dropped by §6.3's normalisation;
 *     they never distinguish words by sound alone over a phone line);
 *   - b and v: one phoneme everywhere (vaca/baca, tuvo/tubo);
 *   - ll and y: yeísmo, now the majority pronunciation in Spain and Latin
 *     America (valla/vaya/baya, pollo/poyo);
 *   - h is silent (hola/ola, hecho/echo); ch is kept as its own sound;
 *   - c before e/i, z, and s: seseo, which covers most of Latin America and
 *     Andalusia (casa/caza, cocer/coser, ciervo/siervo). Spain's distinción
 *     is a strict refinement, so a list safe under seseo is safe there too;
 *   - g before e/i and j: one sound (gente/jente is a spelling error, not a
 *     different word, but gira/jira are both words);
 *   - qu, k, and c before a/o/u: one sound /k/ (quórum/cuórum);
 *   - gu before e/i is /g/, gü is /gw/, gu before a/o is /gw/ — kept apart,
 *     since each is a different sound;
 *   - word-final y is the vowel /i/ (rey/rei, hoy/oi).
 *
 * Not applied, and why — words these would merge are flagged by
 * `unappliedRuleFlags` for the reviewer rather than removed:
 *   - x: /ks/ in most positions, but /s/ before a consonant in casual speech
 *     (extra ≈ estra) and /x/ in a few names (México). Merging x with s would
 *     drop every x word; instead every x word is flagged (spellingFlags);
 *   - initial hie-/hue- against ye-/güe- (hierba/yerba, huevo/güevo): a
 *     dialectal spelling alternation, flagged, not merged;
 *   - syllable-final s dropped or aspirated (Caribbean, Andalusian, Chilean
 *     speech: pasta ≈ pata): too broad to key on; near-duplicates of this
 *     shape show up in the one-letter-apart report instead;
 *   - intervocalic d dropped (-ado ≈ -ao): no candidate pairs in a list of
 *     base-form nouns and adjectives;
 *   - r and rr: distinct phonemes everywhere (pero/perro), kept apart.
 */
export function pronunciationKey(word: string): string {
  let s = stripAccents(word);
  // ch is one sound; protect it from the c rules below.
  s = s.replaceAll("ch", "C");
  s = s.replaceAll("ll", "y");
  s = s.replaceAll("h", "");
  s = s.replaceAll("v", "b");
  s = s.replaceAll("qu", "k");
  s = s.replaceAll("gü", "gw");
  // Hard g before e/i (guerra, guitarra) becomes the token G so the soft-g
  // rule two lines down cannot reach it.
  s = s.replace(/gu([ei])/gu, "G$1");
  s = s.replace(/gu([ao])/gu, "gw$1");
  s = s.replace(/g([ei])/gu, "j$1");
  s = s.replace(/c([ei])/gu, "s$1");
  s = s.replaceAll("z", "s");
  s = s.replaceAll("c", "k");
  s = s.replace(/y$/u, "i");
  s = s.replaceAll("x", "ks");
  s = s.replaceAll("ü", "u");
  return s;
}

/** á é í ó ú → a e i o u. ñ and ü are letters here, not accents. */
function stripAccents(word: string): string {
  return word
    .replaceAll("á", "a")
    .replaceAll("é", "e")
    .replaceAll("í", "i")
    .replaceAll("ó", "o")
    .replaceAll("ú", "u");
}

/* ── Spelling from hearing ──────────────────────────────────────────────── */

/**
 * Letters whose spelling the sound alone does not settle. A word with any of
 * these is kept but flagged, so the reviewer can prefer words a person writes
 * correctly after hearing them once.
 */
export function spellingFlags(word: string): string[] {
  const flags: string[] = [];
  if (word.replaceAll("ch", "").includes("h")) flags.push("spelling:h");
  if (/[bv]/u.test(word)) flags.push("spelling:b/v");
  if (/ll|y/u.test(word)) flags.push("spelling:ll/y");
  if (word.includes("x")) flags.push("spelling:x");
  if (/g[eéií]|j[eéií]/u.test(word)) flags.push("spelling:g/j");
  return flags;
}

/** Words that a merging rule NOT applied by `pronunciationKey` would touch. */
export function unappliedRuleFlags(word: string): string[] {
  const flags: string[] = [];
  if (/^h[iu][aeoáéó]/u.test(word) || /^(ye|güe)/u.test(word)) flags.push("unapplied:hie-hue/ye-güe");
  return flags;
}

/* ── Exclusions ─────────────────────────────────────────────────────────── */

export type Exclusions = { readonly exact: ReadonlySet<string>; readonly prefixes: readonly string[] };

/**
 * es.exclude.txt and es.uncertain.txt: one entry per line, UTF-8, `#` starts
 * a comment, blank lines ignored. An entry ending in `*` matches every word
 * that starts with the rest (`sex*`); any other entry matches exactly.
 */
export function parseWordFile(raw: string): Exclusions {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const line of raw.split("\n")) {
    const entry = line.replace(/#.*$/u, "").trim();
    if (entry === "") continue;
    if (entry.endsWith("*")) prefixes.push(entry.slice(0, -1));
    else exact.add(entry);
  }
  return { exact, prefixes };
}

export function matches(word: string, list: Exclusions): boolean {
  return list.exact.has(word) || list.prefixes.some((p) => word.startsWith(p));
}

/* ── Plural / singular pairs ────────────────────────────────────────────── */

/** `gato` beside `gatos`, `pared` beside `paredes`: the shorter is the base form. */
export function pluralOf(word: string, have: ReadonlySet<string>): string | undefined {
  if (have.has(word + "s")) return word + "s";
  if (have.has(word + "es")) return word + "es";
  return undefined;
}

/* ── Near-duplicates ────────────────────────────────────────────────────── */

/** True when the two spellings are one substitution, insertion or deletion apart. */
export function oneLetterApart(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  if (x.length === y.length) {
    let diff = 0;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const [short, long] = x.length < y.length ? [x, y] : [y, x];
  if (long.length - short.length !== 1) return false;
  let i = 0;
  while (i < short.length && short[i] === long[i]) i++;
  for (let j = i; j < short.length; j++) if (short[j] !== long[j + 1]) return false;
  return true;
}

/** Every pair of words one letter apart, as spelled. Not a §6.3 rule: a dictation aid. */
export function nearDuplicates(words: readonly string[]): [string, string][] {
  const byLength = new Map<number, string[]>();
  for (const w of words) {
    const n = letterCount(w);
    const bucket = byLength.get(n);
    if (bucket) bucket.push(w);
    else byLength.set(n, [w]);
  }
  const pairs: [string, string][] = [];
  for (const [n, bucket] of byLength) {
    const next = byLength.get(n + 1) ?? [];
    for (let i = 0; i < bucket.length; i++) {
      const a = bucket[i]!;
      for (let j = i + 1; j < bucket.length; j++) if (oneLetterApart(a, bucket[j]!)) pairs.push([a, bucket[j]!]);
      for (const b of next) if (oneLetterApart(a, b)) pairs.push([a, b]);
    }
  }
  return pairs;
}

/* ── The file itself ────────────────────────────────────────────────────── */

/**
 * es.txt as committed: one word per line, LF, a final newline, nothing else.
 * Returns the words; the test asserts the shape separately.
 */
export function parseList(raw: string): string[] {
  return raw.split("\n").filter((line) => line !== "");
}

/** Deterministic order: by code point of the NFC form. Not locale collation, which varies by ICU build. */
export function compareWords(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
