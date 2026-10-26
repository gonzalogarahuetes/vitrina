/*
 * Re-runs every automated check on the committed Spanish list (encryption
 * spec §6.3; brief §15.2): es.txt, or es.txt.candidate while a rebuild awaits
 * the owner's review (es-checks.ts, LIST_FILE_NAME). The properties live here, not in the list: a file cannot
 * vouch for itself. The build (scripts/build-wordlist-es.mjs) applies the same
 * checks through the same module (es-checks.ts) when it writes the list; this
 * is what makes a hand edit, a bad merge or a stale build show up in CI.
 *
 * The normalisation is the crate's, through the envelope binding
 * (normalizePassphrase) — never a reimplementation, and no fallback.
 */
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadEnvelope } from "$lib/envelope";
import {
  LETTERS,
  LIST_FILE_NAME,
  LIST_SIZE,
  MAX_LETTERS,
  MIN_LETTERS,
  compareWords,
  letterCount,
  matches,
  nearDuplicates,
  oneLetterApart,
  parseList,
  parseWordFile,
  pluralOf,
  pronunciationKey,
  spellingFlags,
} from "./es-checks";

/*
 * One-letter-apart pairs (casa/cosa) are not a §6.3 requirement; they are
 * flagged for the reviewer and counted here so the number cannot drift
 * upward unnoticed. The build prints the current count.
 */
const NEAR_DUPLICATE_PAIRS_CEILING = 5000;

const here = (name: string) => new URL(name, import.meta.url);
const read = (name: string) => readFile(here(name), "utf8");

describe(`${LIST_FILE_NAME}, the Spanish passphrase wordlist`, () => {
  it("is exactly 7,776 lowercase Spanish words, one per line, unique, in code-point order", async () => {
    const raw = await read(LIST_FILE_NAME);
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.includes("\r")).toBe(false);
    expect(raw.normalize("NFC")).toBe(raw);
    const lines = raw.slice(0, -1).split("\n");
    expect(lines.length).toBe(LIST_SIZE);
    for (const line of lines) {
      expect(line, `line ${JSON.stringify(line)}`).toMatch(LETTERS);
    }
    expect(new Set(lines).size).toBe(LIST_SIZE);
    expect([...lines].sort(compareWords)).toEqual(lines);
  });

  it(`keeps every word between ${MIN_LETTERS} and ${MAX_LETTERS} letters`, async () => {
    const words = parseList(await read(LIST_FILE_NAME));
    const outside = words.filter((w) => letterCount(w) < MIN_LETTERS || letterCount(w) > MAX_LETTERS);
    expect(outside).toEqual([]);
  });

  it("has no two words that normalise identically, by the crate's normalisation (§6.3)", async () => {
    const words = parseList(await read(LIST_FILE_NAME));
    const { envelope } = await loadEnvelope();
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const w of words) {
      const n = envelope.normalizePassphrase(w);
      expect(n, `${w} normalises to nothing`).not.toBe("");
      const other = seen.get(n);
      if (other !== undefined) collisions.push(`${other} / ${w}`);
      seen.set(n, w);
    }
    expect(collisions).toEqual([]);
  });

  it("has no two words with the same pronunciation key (homophones)", async () => {
    const words = parseList(await read(LIST_FILE_NAME));
    const seen = new Map<string, string>();
    const homophones: string[] = [];
    for (const w of words) {
      const k = pronunciationKey(w);
      const other = seen.get(k);
      if (other !== undefined) homophones.push(`${other} / ${w}`);
      seen.set(k, w);
    }
    expect(homophones).toEqual([]);
  });

  it("contains nothing from es.exclude.txt", async () => {
    const exclude = parseWordFile(await read("es.exclude.txt"));
    // A trivially short exclusion list would make this check meaningless.
    expect(exclude.exact.size + exclude.prefixes.length).toBeGreaterThan(500);
    const words = parseList(await read(LIST_FILE_NAME));
    expect(words.filter((w) => matches(w, exclude))).toEqual([]);
  });

  it("has no plural beside its singular", async () => {
    const words = parseList(await read(LIST_FILE_NAME));
    const have = new Set(words);
    const pairs = words.flatMap((w) => {
      const p = pluralOf(w, have);
      return p === undefined ? [] : [`${w} / ${p}`];
    });
    expect(pairs).toEqual([]);
  });

  it(`has at most ${NEAR_DUPLICATE_PAIRS_CEILING} one-letter-apart pairs`, async () => {
    const words = parseList(await read(LIST_FILE_NAME));
    expect(nearDuplicates(words).length).toBeLessThanOrEqual(NEAR_DUPLICATE_PAIRS_CEILING);
  });

  it("names and pins every input it was built from", async () => {
    const sources = JSON.parse(await read("es.sources.json")) as {
      files: { name: string; url: string; sha256: string; retrieved: string; licence: string }[];
    };
    const licence = await read("es.LICENSE.txt");
    expect(sources.files.length).toBeGreaterThan(0);
    for (const f of sources.files) {
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(f.retrieved).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(f.url).toMatch(/^https:\/\//u);
      expect(licence, `es.LICENSE.txt does not mention ${f.url}`).toContain(f.url);
    }
  });
});

describe("the checks themselves", () => {
  it("merges the sound pairs the key is for, and keeps apart the ones it is not", () => {
    const same: [string, string][] = [
      ["vaca", "baca"],
      ["hola", "ola"],
      ["hecho", "echo"],
      ["casa", "caza"],
      ["valla", "vaya"],
      ["baya", "vaya"],
      ["tuvo", "tubo"],
      ["rey", "rei"],
      ["gira", "jira"],
      ["ciervo", "siervo"],
      ["cocer", "coser"],
      ["pollo", "poyo"],
      ["gente", "jente"],
      ["quemar", "kemar"],
      ["café", "cafe"],
    ];
    for (const [a, b] of same) expect(pronunciationKey(a), `${a} / ${b}`).toBe(pronunciationKey(b));
    const different: [string, string][] = [
      ["pero", "perro"],
      ["casa", "cosa"],
      ["guerra", "gerra"],
      ["guitarra", "jitarra"],
      ["pingüino", "pinguino"],
      ["agua", "aga"],
      ["chico", "cico"],
      ["año", "ano"],
    ];
    for (const [a, b] of different) expect(pronunciationKey(a), `${a} / ${b}`).not.toBe(pronunciationKey(b));
  });

  it("flags the letters a listener cannot spell from sound", () => {
    expect(spellingFlags("huevo")).toEqual(["spelling:h", "spelling:b/v"]);
    expect(spellingFlags("chico")).toEqual([]);
    expect(spellingFlags("llave")).toEqual(["spelling:b/v", "spelling:ll/y"]);
    expect(spellingFlags("gente")).toEqual(["spelling:g/j"]);
    expect(spellingFlags("examen")).toEqual(["spelling:x"]);
  });

  it("finds one-letter-apart pairs, by substitution, insertion or deletion", () => {
    expect(oneLetterApart("casa", "cosa")).toBe(true);
    expect(oneLetterApart("pato", "plato")).toBe(true);
    expect(oneLetterApart("casa", "casta")).toBe(true);
    expect(oneLetterApart("casa", "cesta")).toBe(false);
    expect(oneLetterApart("casa", "casa")).toBe(false);
    expect(nearDuplicates(["casa", "cosa", "plato", "pato", "árbol"])).toEqual([
      ["casa", "cosa"],
      ["pato", "plato"],
    ]);
  });

  it("reads exclusion files: comments, blanks, exact words and prefix globs", () => {
    const list = parseWordFile("# comment\n\nsex*  # a prefix\ncoger\n  concha  \n");
    expect([...list.exact]).toEqual(["coger", "concha"]);
    expect(list.prefixes).toEqual(["sex"]);
    expect(matches("sexual", list)).toBe(true);
    expect(matches("coger", list)).toBe(true);
    expect(matches("cogera", list)).toBe(false);
  });
});
