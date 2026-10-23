/*
 * static/licenses/ and LICENCES name the same files, every file has text,
 * every copy slot exists, and every passphrase wordlist the loader offers has
 * an entry: a list cannot ship without its attribution reaching the app.
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { en } from "$lib/copy/en";
import { WORDLISTS } from "$lib/owner/wordlists";
import { LICENCES } from "./licences";

const DIR = new URL("../../static/licenses/", import.meta.url);

describe("the licences shipped with the app", () => {
  it("LICENCES lists exactly the files in static/licenses/", () => {
    expect(LICENCES.map((l) => l.file).sort()).toEqual(readdirSync(DIR).sort());
  });

  it("every file has text, and every entry a copy slot", () => {
    for (const l of LICENCES) {
      expect(readFileSync(new URL(l.file, DIR), "utf8").trim().length, l.file).toBeGreaterThan(0);
      expect(typeof en[l.covers], l.covers).toBe("string");
    }
  });

  it("every wordlist the loader offers has its attribution here", () => {
    const covered = LICENCES.flatMap((l) => (l.wordlist === undefined ? [] : [l.wordlist])).sort();
    expect(covered).toEqual(WORDLISTS.map((w) => w.language).sort());
  });

  it("the font that ships has its licence", () => {
    expect(readdirSync(new URL("../../static/fonts/", import.meta.url)).some((f) => f.startsWith("AtkinsonHyperlegible"))).toBe(true);
    expect(LICENCES.some((l) => l.file.startsWith("OFL-AtkinsonHyperlegible"))).toBe(true);
  });
});
