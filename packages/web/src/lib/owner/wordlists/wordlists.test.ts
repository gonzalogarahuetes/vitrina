/*
 * Encryption spec §6.3's build-time checks on en.txt, EFF's long list: at
 * least 7,776 words, and no two normalising to the same string. Normalisation
 * is the crate's, through the binding (normalizePassphrase): a TypeScript copy
 * of it would be a second implementation of a permanent interop rule, which is
 * exactly how the two sides drift. Plus what the app relies on: no word
 * normalises to nothing or to more than one word (the recipient types words
 * into separate fields, and the owner's wrap joins them with single spaces).
 *
 * The loader offers every `<language>.txt` it finds, so any other language's
 * list arrives with its own §6.3 test, after its review. What every list must
 * have, whatever its language, is checked below over all of them: a licence
 * beside it, and the loader seeing exactly the files that are lists.
 */
import { loadEnvelope } from "$lib/envelope";
import { describe, expect, it } from "vitest";
import en from "./en.txt?raw";
import { languageOf, LIST_FILE, parseWordlist, WORDLISTS } from "./index";

const lists = Object.fromEntries(
  Object.entries(import.meta.glob<string>("./*.txt", { query: "?raw", import: "default", eager: true })).filter(([path]) => LIST_FILE.test(path)),
);
const licences = import.meta.glob<string>("./*.LICENSE.txt", { query: "?raw", import: "default", eager: true });

const MIN_WORDS = 7776;

describe("en.txt, EFF's long list (encryption spec §6.3)", () => {
  const words = parseWordlist(en);

  it(`has at least ${MIN_WORDS} words`, () => {
    expect(words.length).toBeGreaterThanOrEqual(MIN_WORDS);
  });

  it("has no two words that normalise alike, and every word stays one non-empty word", async () => {
    const { envelope } = await loadEnvelope();
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    const broken: string[] = [];
    for (const word of words) {
      const n = envelope.normalizePassphrase(word);
      if (n === "" || n.includes(" ")) broken.push(word);
      const first = seen.get(n);
      if (first !== undefined) collisions.push(`${first} / ${word} → ${n}`);
      else seen.set(n, word);
    }
    expect(broken, "normalises to nothing, or to more than one word").toEqual([]);
    expect(collisions.slice(0, 20), `${collisions.length} collisions`).toEqual([]);
  });

  it("the binding's normalisation is §6.3's, final sigma included (vector 10's spellings)", async () => {
    const { envelope } = await loadEnvelope();
    // ΓΑΤΑΣ, γάτας (precomposed ά, final ς), γατασ — as escapes, so no editor can recompose them.
    const spellings = ["\u0393\u0391\u03a4\u0391\u03a3", "\u03b3\u03ac\u03c4\u03b1\u03c2", "\u03b3\u03b1\u03c4\u03b1\u03c3"];
    expect(spellings.map((s) => envelope.normalizePassphrase(s))).toEqual(Array(3).fill("\u03b3\u03b1\u03c4\u03b1\u03c3"));
  });
});

describe("every list, whatever its language", () => {
  it("the loader offers exactly the files that are lists, en.txt among them", () => {
    expect(Object.keys(lists)).toContain("./en.txt");
    expect(WORDLISTS.map((l) => l.language).sort()).toEqual(Object.keys(lists).map(languageOf).sort());
  });

  for (const path of Object.keys(lists)) {
    const language = languageOf(path);
    it(`${path} has its licence beside it`, () => {
      const licence = licences[`./${language}.LICENSE.txt`];
      expect(licence, `${language}.LICENSE.txt`).toBeDefined();
      expect((licence ?? "").trim().length).toBeGreaterThan(0);
    });
  }
});

describe("which files are lists", () => {
  it("a language code and .txt, nothing else", () => {
    for (const ok of ["./en.txt", "./es.txt", "./pt-BR.txt", "./sr-Latn.txt", "./fil.txt"]) expect(LIST_FILE.test(ok), ok).toBe(true);
    for (const no of ["./en.LICENSE.txt", "./es.exclude.txt", "./es.uncertain.txt", "./eff_large_wordlist.txt", "./EN.txt", "./en.md"]) expect(LIST_FILE.test(no), no).toBe(false);
  });
});

describe("parseWordlist", () => {
  it("drops EFF's dice column and keeps a plain list as it is", () => {
    expect(parseWordlist("11111\tabacus\n11112\tabdomen\n")).toEqual(["abacus", "abdomen"]);
    expect(parseWordlist("año\r\ncanción\n\n")).toEqual(["año", "canción"]);
  });

  it("changes nothing else, so the test above sees the file as it is", () => {
    expect(parseWordlist("Word\n word \n12345\n")).toEqual(["Word", " word ", "12345"]);
  });
});
