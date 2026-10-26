#!/usr/bin/env node
/*
 * Builds the Spanish passphrase wordlist (encryption spec §6.3, brief §15.2)
 * into src/lib/owner/wordlists/ (es-checks.ts, LIST_FILE_NAME: `es.txt`, or
 * `es.txt.candidate` — a name the loader ignores — while a rebuild awaits
 * review) and the review sheet for the fluent reader brief §15.3 requires,
 * beside it.
 *
 * From packages/web, after `pnpm --filter @vitrina/envelope build:wasm`:
 *
 *   pnpm wordlist:es                      # inputs in <checkout>/corpus/
 *   pnpm wordlist:es --corpus=/path/to/   # inputs elsewhere; --wasm=/path/to/ likewise for the binding build
 *
 * Inputs, all owner-supplied and gitignored (es.sources.json has the URLs,
 * retrieval dates and hashes; a file whose SHA-256 does not match stops the
 * build, so a changed upstream file can never silently change the list):
 *
 *   - es_full.txt                        OpenSubtitles 2018 word frequencies
 *                                        (hermitdave/FrequencyWords, CC-BY-SA 4.0).
 *                                        The rank order: spoken familiarity.
 *   - kaikki.org-dictionary-Spanish.jsonl  Wiktionary's Spanish entries (CC BY-SA 3.0):
 *                                        what a word IS — part of speech, inflected
 *                                        or base form, register, topic, region.
 *   - es_ancora-ud-*.conllu, es_gsd-ud-*.conllu  UD Spanish treebanks (CC BY 4.0,
 *                                        CC BY-SA 3.0): what a word DOES in running
 *                                        text, by lemma and UPOS per token.
 *
 * Normalisation is the crate's, through the envelope binding
 * (envelope.normalizePassphrase). There is no copy of it here and must never
 * be one. `--skip-collisions` exists for a binding that lacks the export and
 * writes a PROVISIONAL list; es.test.ts is red on such a list, which is the point.
 *
 * Every other check lives in src/lib/owner/wordlists/es-checks.ts, shared
 * with the test so the committed file is re-checked by the same code.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
  parseWordFile,
  pluralOf,
  pronunciationKey,
  spellingFlags,
  unappliedRuleFlags,
} from "../src/lib/owner/wordlists/es-checks.ts";

const WEB = new URL("../", import.meta.url);
const REPO = new URL("../../", WEB);
const WORDLISTS = new URL("src/lib/owner/wordlists/", WEB);

const args = new Set(process.argv.slice(2));
const option = (name, fallback) => {
  const hit = [...args].find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const SKIP_COLLISIONS = args.has("--skip-collisions");
const CORPUS = new URL(option("corpus", "corpus/").replace(/\/?$/u, "/"), REPO);
// The binding build (gitignored). `--wasm=` points at another checkout's while this one has none.
const WASM_DIR = new URL(option("wasm", "packages/envelope/wasm/").replace(/\/?$/u, "/"), REPO);
const OUT = new URL(LIST_FILE_NAME, WORDLISTS);
const REVIEW = new URL("es.review.tsv", WORDLISTS);
const DROPPED = new URL("es.dropped.tsv", WORDLISTS);

/* ── 1. Inputs, pinned by hash ──────────────────────────────────────────── */

const sources = JSON.parse(await readFile(new URL("es.sources.json", WORDLISTS), "utf8"));
const files = {}; // name → text, for the inputs small enough to hold (the dictionary is streamed in §2a)
for (const file of sources.files) {
  const path = new URL(file.name, CORPUS);
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } catch {
    fail(`missing ${fileURLToPath(path)}\n  download it from ${file.url}`);
  }
  const sha256 = hash.digest("hex");
  if (sha256 !== file.sha256) {
    fail(
      `${file.name}: SHA-256 is ${sha256}, es.sources.json pins ${file.sha256}.\n` +
        `  The upstream file has changed, or the download is damaged. Refusing to build a list\n` +
        `  from an input the manifest does not describe; re-pin deliberately if the change is wanted.`,
    );
  }
  if (!file.name.endsWith(".jsonl")) files[file.name] = await readFile(path, "utf8");
}

/* ── 2a. The dictionary oracle: Wiktionary, by word ─────────────────────── */

/*
 * One line of JSON per entry (word + part of speech). A word is a base-form
 * noun or adjective when some noun/adj entry has a sense that is not itself
 * an inflected form, an alternative spelling, a misspelling or an abbreviation.
 * The base form of an adjective is the masculine singular, so "bonita" is
 * inflected. A feminine noun given only as "female equivalent of X" ("amiga")
 * is accepted when the treebanks lemmatise it to itself (§3): it is its own
 * word in text, as "niña" and "hermana" are in the dictionary.
 */
const NOT_BASE = new Set(["form-of", "alt-of", "misspelling", "abbreviation", "initialism", "acronym", "clipping", "plural"]);
const DATED = new Set(["obsolete", "archaic", "dated", "historical", "rare"]);
const CONTENT = new Set(["vulgar", "offensive", "derogatory", "pejorative", "slang", "ethnic", "sexual"]);

/*
 * Wiktionary's topical categories, check 5's second net beside es.exclude.txt.
 * A word in an EXCLUDED category is dropped; one in a FLAGGED category is kept
 * and flagged for the reviewer; one in a regional category (a country name)
 * is flagged `regional`, since a word one country uses is a poor choice for a
 * recipient in another.
 */
const EXCLUDED_CATEGORIES = new Set([
  "Sex", "Sexuality", "Genitalia", "Buttocks", "Breasts", "LGBTQ", "Prostitution", "Pornography", "Masturbation",
  "Death", "Burial", "Murder", "Suicide", "Violence", "War", "Military", "Weapons", "Firearms", "Crime", "Law enforcement",
  "Medicine", "Pathology", "Diseases", "Medical signs and symptoms", "Surgery", "Pharmaceutical drugs", "Pharmacology",
  "Psychiatry", "Neurology", "Healthcare occupations", "Skeleton", "Muscles", "Recreational drugs", "Alcoholic beverages",
  "Distilled beverages", "Drinking", "Feces", "Bodily fluids", "Urine", "Excretion", "Vomiting", "Menstruation",
  "Religion", "Christianity", "Roman Catholicism", "Catholicism", "Islam", "Judaism", "Theology", "Monasticism",
  "Bible", "Books of the Bible", "Biblical characters", "Gods", "Greek deities", "Clergy",
  "Politics", "Government", "Marxism", "Monarchy", "Fascism", "Communism", "Nationalism",
  "Demonyms", "Nationalities", "Ethnonyms", "Ethnic slurs", "People with disabilities",
  // Technical vocabulary nobody reads aloud to a grandparent.
  "Chemistry", "Organic chemistry", "Inorganic chemistry", "Organic compounds", "Biochemistry", "Enzymes", "Proteins",
  "Carbohydrates", "Hormones", "Genetics", "Cytology", "Subatomic particles", "Chemical elements", "Paleontology",
]);
const FLAGGED_CATEGORIES = new Set([
  "Anatomy", "Body parts", "Animal body parts", "Hair", "Emotions", "Fear", "Anger", "Law", "Finance", "Economics",
  "Business", "Bullfighting", "Vesre", "Lunfardo", "Internet", "Mythological creatures", "Greek mythology", "Mythology",
  "Astrology", "Marriage", "Age", "Appearance", "Heraldry", "Hunting", "Fishing", "Card games", "Gambling", "Fire",
  "Computing", "Video games", "Television", "Physics", "Mathematics", "Geometry", "Linguistics", "Grammar",
]);

const REGIONS = new Set([
  "Spain", "Mexico", "Argentina", "Chile", "Colombia", "Peru", "Venezuela", "Cuba", "Uruguay", "Paraguay", "Ecuador",
  "Bolivia", "Guatemala", "Honduras", "El Salvador", "Nicaragua", "Costa Rica", "Panama", "Dominican Republic",
  "Puerto Rico", "Philippines", "Andalusia", "Canary Islands", "Latin America", "Central America", "Caribbean",
  "Rioplatense", "United States", "Equatorial Guinea",
]);

/*
 * A spelling Spanish orthography can carry, for the borrowings Wiktionary
 * records without an etymology ("stout", "random", "offshore"): a Spanish word
 * ends in a vowel or in d, l, n, r, s, z, j, x or y; doubles only ll, rr, cc,
 * nn and ee; has no sh, ph, th, ck or wh; and never stacks four consonants.
 */
function looksSpanish(word) {
  const plain = word.replaceAll("ñ", "n").replaceAll("ü", "u").replace(/[áéíóú]/gu, (v) => "aeiou"["áéíóú".indexOf(v)]);
  if (!/[aeioudlnrszjxy]$/u.test(plain)) return false;
  if (/(.)\1/u.test(plain.replace(/ll|rr|cc|nn|ee/gu, "_"))) return false;
  if (/sh|ph|th|ck|wh/u.test(plain)) return false;
  if (/[^aeiou]{4}/u.test(plain)) return false;
  return true;
}

const wikt = new Map(); // word → { base, inflected, pos: Set<pos>, feminineOnly, verbLemma, loanword, current, content, excluded, flagged, regional }
{
  const path = sources.files.find((f) => f.name.endsWith(".jsonl"))?.name;
  if (!path) fail("es.sources.json names no .jsonl dictionary file");
  const lines = createInterface({ input: createReadStream(new URL(path, CORPUS)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line === "") continue;
    const e = JSON.parse(line);
    if (e.lang_code !== "es" || typeof e.word !== "string" || !LETTERS.test(e.word)) continue;
    let w = wikt.get(e.word);
    if (!w) {
      wikt.set(e.word, (w = {
        base: new Set(), inflected: new Set(), pos: new Set(), feminineOnly: false, verbLemma: false, loanword: false,
        current: false, general: false, formal: false, clean: false, senseRegions: new Set(),
        content: new Set(), excluded: new Set(), flagged: new Set(), regional: new Set(),
      }));
    }
    w.pos.add(e.pos);
    // Unadapted borrowings ("outfit", "hanging"): the `ety` template's ":ubor", or the older `ubor` templates.
    for (const t of e.etymology_templates ?? []) {
      if (t.name === "ubor" || t.name === "ubor+" || (t.name === "ety" && Object.values(t.args ?? {}).includes(":ubor"))) w.loanword = true;
    }
    const categories = [...(e.categories ?? []), ...(e.senses ?? []).flatMap((s) => s.categories ?? [])].map((c) => c.name);
    for (const c of categories) {
      if (EXCLUDED_CATEGORIES.has(c)) w.excluded.add(c);
      else if (FLAGGED_CATEGORIES.has(c)) w.flagged.add(c);
      else if (/^[A-Z][a-z]+( [A-Z][a-z]+)*$/u.test(c) && REGIONS.has(c)) w.regional.add(c);
    }
    for (const s of e.senses ?? []) {
      const tags = new Set([...(s.tags ?? []), ...(s.raw_tags ?? [])]);
      const isForm = [...tags].some((t) => NOT_BASE.has(t)) || (s.form_of?.length ?? 0) > 0 || (s.alt_of?.length ?? 0) > 0;
      for (const t of tags) {
        if (!CONTENT.has(t)) continue;
        // Region labels are capitalised tags on the same sense (Chile, Rioplatense, Latin-America).
        const where = [...tags].filter((r) => /^[A-Z]/u.test(r)).join("/");
        w.content.add(where ? `${t}:${where}` : t);
      }
      if (e.pos === "verb" && !isForm) {
        // An infinitive is a base form (decided 22 October 2026); conjugated
        // forms are form-of senses and stay out.
        w.verbLemma = true;
        w.base.add("verb");
        if (![...tags].some((t) => DATED.has(t))) w.current = true;
        if (![...tags].some((t) => CONTENT.has(t))) w.clean = true;
        if (![...tags].filter((r) => /^[A-Z]/u.test(r)).length) w.general = true;
        if (!tags.has("colloquial") && !tags.has("slang") && !tags.has("informal")) w.formal = true;
        continue;
      }
      if (e.pos !== "noun" && e.pos !== "adj") continue;
      if (isForm) {
        if (e.pos === "noun" && tags.has("feminine") && !tags.has("plural") && tags.has("form-of")) w.feminineOnly = true;
        w.inflected.add(e.pos);
        continue;
      }
      w.base.add(e.pos);
      if (![...tags].some((t) => DATED.has(t))) w.current = true;
      // A base sense that is neither regional nor colloquial: the word is general Spanish.
      const regionTags = [...tags].filter((r) => /^[A-Z]/u.test(r));
      if (regionTags.length === 0) w.general = true;
      else for (const r of regionTags) w.senseRegions.add(r);
      if (!tags.has("colloquial") && !tags.has("slang") && !tags.has("informal")) w.formal = true;
      if (![...tags].some((t) => CONTENT.has(t))) w.clean = true;
    }
  }
}

/* ── 2b. The in-context oracle: every treebank token, by lowercase form ─── */

const tagged = new Map(); // form → { total, upos: Map<UPOS, n>, base: n (NOUN/ADJ/VERB/AUX with lemma == form: a base form in text) }
const sentences = []; // Set<lemma> per sentence, for the religion pass below
{
  let current = new Set();
  const endSentence = () => {
    if (current.size > 0) sentences.push(current);
    current = new Set();
  };
  for (const [name, text] of Object.entries(files)) {
    if (!name.endsWith(".conllu")) continue;
    for (const line of text.split("\n")) {
      if (line === "") {
        endSentence();
        continue;
      }
      if (line.startsWith("#")) continue;
      const cols = line.split("\t");
      if (cols.length < 4 || !/^\d+$/u.test(cols[0])) continue; // multiword ranges and empty nodes carry no UPOS of their own
      const form = cols[1].toLowerCase();
      const lemma = cols[2].toLowerCase();
      const upos = cols[3];
      if (!LETTERS.test(form)) continue;
      if (upos === "NOUN" || upos === "ADJ" || upos === "VERB" || upos === "PROPN") current.add(lemma);
      let entry = tagged.get(form);
      if (!entry) tagged.set(form, (entry = { total: 0, upos: new Map(), base: 0 }));
      entry.total++;
      entry.upos.set(upos, (entry.upos.get(upos) ?? 0) + 1);
      if ((upos === "NOUN" || upos === "ADJ" || upos === "VERB" || upos === "AUX") && lemma === form) entry.base++;
    }
    endSentence();
  }
}

/* ── 2c. Religion, beyond Wiktionary's categories ───────────────────────── */

/*
 * `santería` reached the list because Wiktionary files it under nothing, so
 * check 5 gets a second net for this one category: a hand-written seed list,
 * widened two ways — words sharing a seed's stem (santo → santería,
 * santiguar), and treebank lemmas that keep company with the seeds (a lemma
 * is "related" when at least a quarter of the sentences it appears in also
 * contain a seed, in at least three sentences; the base rate is far lower).
 * Hits are flagged `religion:…` on the review sheet, never dropped: the
 * company a word keeps is evidence for a reviewer, not a verdict.
 */
const RELIGION_SEEDS = [
  "iglesia", "misa", "santo", "santa", "cura", "rezar", "rezo", "oración", "bautizo", "bautizar", "bautismo", "santería",
  "dios", "diosa", "virgen", "ángel", "cielo", "infierno", "pecado", "alma", "fe", "templo", "mezquita", "sinagoga", "rabino",
  "imán", "monja", "monje", "fraile", "obispo", "arzobispo", "cardenal", "papa", "pontífice", "vaticano", "cristo", "jesús",
  "jesucristo", "biblia", "evangelio", "altar", "cruz", "crucifijo", "rosario", "hostia", "comunión", "confesión", "bendición",
  "bendecir", "milagro", "profeta", "apóstol", "discípulo", "santuario", "peregrino", "peregrinación", "romería", "religión",
  "religioso", "sagrado", "divino", "celestial", "demonio", "diablo", "satanás", "brujería", "hechizo", "ritual", "rito",
  "culto", "secta", "vudú", "chamán", "orisha", "espiritismo", "espíritu", "karma", "nirvana", "buda", "budismo", "islam",
  "musulmán", "judío", "judaísmo", "cristiano", "cristianismo", "católico", "catolicismo", "protestante", "evangélico",
  "ramadán", "pascua", "navidad", "cuaresma", "adviento", "procesión", "cofradía", "penitente", "nazareno", "limosna",
  "diezmo", "catequesis", "parroquia", "párroco", "capilla", "catedral", "convento", "monasterio", "abadía", "sacerdote",
  "clérigo", "clero", "pastor", "misionero", "misión", "mártir", "beato", "canonizar", "sagrario", "cáliz", "incienso",
  "arcángel", "querubín", "paraíso", "purgatorio", "limbo", "resurrección", "resucitar", "apocalipsis", "mesías",
  "salvación", "redención", "redentor", "salvador", "bendito", "maldito", "amén", "aleluya", "plegaria", "ayuno", "voto",
  "hábito", "sotana", "velo", "credo", "dogma", "herejía", "hereje", "pagano", "ateo", "creyente", "devoto", "piadoso",
  "piedad", "fiel", "converso", "confirmación", "eucaristía", "sacramento", "unción", "sermón", "homilía", "predicar",
  "predicador", "orar", "adorar", "adoración", "venerar", "veneración", "reliquia", "icono", "ermita", "capellán",
  "seminario", "seminarista", "novicio", "abad", "abadesa", "priora", "superiora", "hermano", "hermana", "fe",
];
const RELIGION_SEED_SET = new Set(RELIGION_SEEDS);
/** A seed's stem: the word less a common ending, long enough to mean something (sant-, bautiz-, pecad-). */
function stemOf(word) {
  const stem = word.replace(/(ería|ción|sión|dad|ismo|ista|ico|ica|oso|osa|ar|er|ir|o|a|e)$/u, "");
  return stem.length >= 4 ? stem : undefined;
}
const RELIGION_STEMS = new Map(); // stem → seed
for (const seed of RELIGION_SEEDS) {
  const stem = stemOf(seed);
  if (stem && !RELIGION_STEMS.has(stem)) RELIGION_STEMS.set(stem, seed);
}
// Treebank company: lemmas that appear with a seed in ≥ 25% of their sentences, ≥ 3 times.
const RELIGION_RELATED = new Map(); // lemma → "seedA/seedB"
{
  const perLemma = new Map(); // lemma → { n, withSeed, seeds: Set }
  let seedSentences = 0;
  for (const lemmas of sentences) {
    const seedsHere = [...lemmas].filter((l) => RELIGION_SEED_SET.has(l));
    if (seedsHere.length > 0) seedSentences++;
    for (const l of lemmas) {
      let e = perLemma.get(l);
      if (!e) perLemma.set(l, (e = { n: 0, withSeed: 0, seeds: new Set() }));
      e.n++;
      if (seedsHere.length > 0) {
        e.withSeed++;
        for (const s of seedsHere) if (s !== l) e.seeds.add(s);
      }
    }
  }
  const baseRate = seedSentences / sentences.length;
  for (const [l, e] of perLemma) {
    if (RELIGION_SEED_SET.has(l)) continue;
    if (e.withSeed >= 3 && e.withSeed / e.n >= Math.max(0.25, 8 * baseRate)) RELIGION_RELATED.set(l, [...e.seeds].slice(0, 3).join("/"));
  }
}
function religionFlag(word) {
  if (RELIGION_SEED_SET.has(word)) return "religion:seed";
  for (const [stem, seed] of RELIGION_STEMS) if (word.startsWith(stem) && word !== seed) return `religion:stem(${seed})`;
  const company = RELIGION_RELATED.get(word);
  if (company) return `religion:company(${company})`;
  return undefined;
}

/* ── 3. Candidates in corpus rank order ─────────────────────────────────── */

const exclude = parseWordFile(await readFile(new URL("es.exclude.txt", WORDLISTS), "utf8"));
const uncertain = parseWordFile(await readFile(new URL("es.uncertain.txt", WORDLISTS), "utf8"));

const seen = new Set();
const candidates = []; // { word, rank, count }
let rank = 0;
for (const line of files["es_full.txt"].split("\n")) {
  if (line === "") continue;
  rank++;
  const [word, count] = line.split(" ");
  if (seen.has(word)) continue;
  seen.add(word);
  candidates.push({ word, rank, count: Number(count) });
}

const dropped = []; // { word, rank, reason }
const drop = (c, reason) => dropped.push({ word: c.word, rank: c.rank, reason });

const pool = [];
for (const c of candidates) {
  const { word } = c;
  if (!LETTERS.test(word)) continue; // punctuation, digits, k/w, uppercase: not even worth reporting
  const n = letterCount(word);
  if (n < MIN_LETTERS || n > MAX_LETTERS) continue;
  if (matches(word, exclude)) {
    drop(c, "excluded");
    continue;
  }
  // The dictionary decides what the word IS; the treebanks decide what it
  // mostly DOES in running text, which catches base forms that are almost
  // always something else when spoken ("era" is a noun, and an auxiliary
  // 99% of the time).
  const w = wikt.get(word);
  if (!w) {
    drop(c, "not-in-dictionary");
    continue;
  }
  const t = tagged.get(word);
  const ownLemmaInText = t !== undefined && t.base > 0;
  if (w.base.size === 0 && !(w.feminineOnly && ownLemmaInText)) {
    if (w.inflected.size > 0) drop(c, "inflected");
    else if (w.pos.has("name") && w.pos.size === 1) drop(c, "proper-noun");
    else drop(c, `pos:${[...w.pos].join("/")}`);
    continue;
  }
  if (w.base.size > 0 && !w.current) {
    drop(c, "dated");
    continue;
  }
  if (w.loanword || !looksSpanish(word)) {
    drop(c, w.loanword ? "loanword" : "spelling:foreign");
    continue;
  }
  if (w.excluded.size > 0) {
    drop(c, `category:${[...w.excluded].join("/")}`);
    continue;
  }
  // Every dictionary sense is vulgar, offensive or derogatory: no reviewer is
  // needed. A word with one such sense beside a plain one is flagged instead.
  if (w.base.size > 0 && !w.clean) {
    drop(c, `content:wikt-only(${[...w.content].join(",")})`);
    continue;
  }
  const flags = [];
  let pos = w.base.has("noun") || w.feminineOnly ? "noun" : w.base.has("adj") ? "adj" : "verb";
  if (w.feminineOnly && w.base.size === 0) flags.push("pos:feminine-of");
  if (w.flagged.size > 0) flags.push(`category:${[...w.flagged].join("/")}`);
  const regions = new Set([...w.regional, ...w.senseRegions]);
  if (w.base.size > 0 && !w.general) flags.push(`regional-only:${[...regions].join("/")}`);
  else if (regions.size > 0) flags.push(`regional:${[...regions].join("/")}`);
  if (w.base.size > 0 && !w.formal) flags.push("register:colloquial-only");
  if (t) {
    const share = (tag) => (t.upos.get(tag) ?? 0) / t.total;
    // The readings the dictionary admits as base forms: noun, adjective and,
    // for an infinitive, verb. Conjugated-form tokens share the verb tag but
    // never the lemma; that is what the lemma check below is for.
    const nounAdj = share("NOUN") + share("ADJ") + (w.verbLemma ? share("VERB") + share("AUX") : 0);
    if (share("PROPN") > 0.3) {
      drop(c, "proper-noun");
      continue;
    }
    // In running text the form is (almost) never one of those: "dije" is a
    // pendant in the dictionary and "I said" everywhere else.
    if ((t.total >= 5 && nounAdj < 0.2) || (t.total >= 2 && nounAdj === 0)) {
      const dominant = [...t.upos.entries()].sort((a, b) => b[1] - a[1])[0][0];
      drop(c, `pos:mostly-${dominant}`);
      continue;
    }
    if (t.total >= 5 && nounAdj < 0.6) flags.push(`pos:mixed(${Math.round(nounAdj * 100)}% base reading in text)`);
    // The dictionary calls a feminine noun a base form; the treebank lemma says
    // whether text treats the word as its own lemma or as an inflection.
    const baseTagged = ["NOUN", "ADJ", ...(w.verbLemma ? ["VERB", "AUX"] : [])].reduce((n, u) => n + (t.upos.get(u) ?? 0), 0);
    if (t.base === 0 && baseTagged >= 3) {
      drop(c, "inflected-in-text");
      continue;
    }
    if (pos !== "verb" && share("NOUN") < share("ADJ")) pos = "adj";
  } else {
    flags.push("pos:not-in-treebanks");
  }
  if (w.pos.has("verb") && !w.verbLemma) flags.push("pos:also-verb-form");
  if (w.pos.has("name")) flags.push("pos:also-name");
  if (w.content.size > 0) flags.push(`content:wikt(${[...w.content].join(",")})`);
  if (matches(word, uncertain)) flags.push("content:uncertain");
  const religion = religionFlag(word);
  if (religion) flags.push(religion);
  flags.push(...spellingFlags(word), ...unappliedRuleFlags(word));
  if (word.endsWith("s")) flags.push("ends-in-s");
  pool.push({ ...c, pos, flags });
}

/* ── 4. Pairwise checks over the pool, most frequent word first ─────────── */

// Plural beside its singular: the base-form filter should leave none; a safety net.
const inPool = new Set(pool.map((c) => c.word));
let kept = pool.filter((c) => {
  const base = c.word.endsWith("es") && inPool.has(c.word.slice(0, -2)) ? c.word.slice(0, -2)
    : c.word.endsWith("s") && inPool.has(c.word.slice(0, -1)) ? c.word.slice(0, -1)
    : undefined;
  if (base !== undefined) drop(c, `plural-of:${base}`);
  return base === undefined;
});

// §6.3: no two words may normalise identically. Both words of a pair go — the
// person hearing one cannot know which was meant.
let normalize;
{
  const { default: init, ...envelope } = await import(new URL("envelope.js", WASM_DIR));
  await init({ module_or_path: await readFile(new URL("envelope_bg.wasm", WASM_DIR)) });
  normalize = envelope.normalizePassphrase;
}
let collisions = 0;
if (typeof normalize === "function") {
  const byNormalised = new Map();
  for (const c of kept) {
    const norm = normalize(c.word);
    const group = byNormalised.get(norm);
    if (group) group.push(c);
    else byNormalised.set(norm, [c]);
  }
  kept = kept.filter((c) => {
    const group = byNormalised.get(normalize(c.word));
    if (group.length === 1) return true;
    drop(c, `collision:${group.filter((o) => o !== c).map((o) => o.word).join("|")}`);
    collisions++;
    return false;
  });
} else if (SKIP_COLLISIONS) {
  console.error("WARNING: envelope.normalizePassphrase is not in this build of the binding.");
  console.error("         Skipping the §6.3 collision check: the list written is PROVISIONAL.");
} else {
  fail(
    "envelope.normalizePassphrase is not in this build of the binding. Rebuild it, or pass\n" +
      "  --skip-collisions to write a PROVISIONAL list without the §6.3 collision check.",
  );
}

// Homophones: one word per pronunciation key, the most frequent.
const byKey = new Map();
let homophones = 0;
kept = kept.filter((c) => {
  const key = pronunciationKey(c.word);
  const first = byKey.get(key);
  if (first) {
    drop(c, `homophone-of:${first.word}`);
    first.flags.push(`homophone-dropped:${c.word}`);
    homophones++;
    return false;
  }
  byKey.set(key, c);
  return true;
});

if (kept.length < LIST_SIZE) {
  console.error(`candidate pool after single-word checks: ${pool.length}; dropped, by reason (whole corpus):`);
  for (const [r, n] of [...countReasons(Infinity)].sort((a, b) => b[1] - a[1])) console.error(`  ${String(n).padStart(6)}  ${r}`);
  fail(`only ${kept.length} words survive every check; ${LIST_SIZE} are required (§6.3). The list cannot be built from these inputs.`);
}
const list = kept.slice(0, LIST_SIZE);
const lastRank = list[list.length - 1].rank;

// Near-duplicates, as spelled: not a §6.3 rule, a dictation aid. Flagged, not dropped.
const pairs = nearDuplicates(list.map((c) => c.word));
const byWord = new Map(list.map((c) => [c.word, c]));
for (const [a, b] of pairs) {
  byWord.get(a).flags.push(`near:${b}`);
  byWord.get(b).flags.push(`near:${a}`);
}

/* ── 5. Outputs ─────────────────────────────────────────────────────────── */

const words = list.map((c) => c.word).sort(compareWords);
await writeFile(OUT, words.join("\n") + "\n", "utf8");

const WEIGHT = {
  "content:wikt": 100,
  "content:uncertain": 100,
  "religion": 60,
  "category": 40,
  "regional-only": 30,
  "register:colloquial-only": 20,
  "regional": 8,
  "pos:feminine-of": 15,
  "pos:mixed": 20,
  "pos:also-verb-form": 8,
  "pos:also-name": 8,
  "pos:not-in-treebanks": 10,
  "unapplied": 6,
  "near": 5,
  "spelling:h": 3,
  "spelling:b/v": 3,
  "spelling:ll/y": 3,
  "spelling:x": 3,
  "spelling:g/j": 3,
  "homophone-dropped": 2,
  "ends-in-s": 2,
};
const risk = (c) =>
  c.flags.reduce((sum, f) => sum + (WEIGHT[Object.keys(WEIGHT).find((k) => f.startsWith(k)) ?? ""] ?? 0), 0) +
  (c.rank > 50000 ? 10 : 0);

const tsv = (rows) => rows.map((r) => r.join("\t")).join("\n") + "\n";
const review = [...list]
  .map((c) => ({ ...c, risk: risk(c) }))
  .sort((a, b) => b.risk - a.risk || a.rank - b.rank)
  .map((c) => [c.word, c.rank, c.count, c.pos, c.risk, c.flags.join("; "), ""]);
await writeFile(
  REVIEW,
  tsv([["word", "rank", "count", "pos", "risk", "flags", "reject (write anything here to drop the word)"], ...review]),
  "utf8",
);
const droppedRows = dropped
  .filter((d) => d.rank <= lastRank)
  .sort((a, b) => a.rank - b.rank)
  .map((d) => [d.word, d.rank, d.reason]);
await writeFile(DROPPED, tsv([["word", "rank", "reason"], ...droppedRows]), "utf8");

/* ── 6. Report ──────────────────────────────────────────────────────────── */

const reasons = countReasons(lastRank);
const flagCounts = new Map();
for (const c of list) for (const f of c.flags) {
  const r = f.replace(/[:(].*$/u, "");
  flagCounts.set(r, (flagCounts.get(r) ?? 0) + 1);
}
console.log(`${words.length} words written to ${fileURLToPath(OUT)}${typeof normalize === "function" ? "" : "  (PROVISIONAL: no collision check)"}`);
console.log(`candidate pool after single-word checks: ${pool.length}; survivors of pairwise checks: ${kept.length}`);
console.log(`deepest corpus rank used: ${lastRank}`);
console.log(`dropped above that rank, by reason:`);
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${r}`);
console.log(`normalisation collisions removed (both words): ${typeof normalize === "function" ? collisions : "not checked"}`);
console.log(`homophones removed (second and later per key): ${homophones}`);
console.log(`near-duplicate pairs remaining in the list: ${pairs.length}`);
console.log(`flags on kept words:`);
for (const [r, n] of [...flagCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(6)}  ${r}`);
console.log(`review sheet: ${fileURLToPath(REVIEW)}; what the checks dropped above the deepest rank used: ${fileURLToPath(DROPPED)}`);

function countReasons(upToRank) {
  const reasons = new Map();
  for (const d of dropped) {
    if (d.rank > upToRank) continue;
    const r = d.reason.replace(/:.*$/u, "");
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  return reasons;
}

function fail(message) {
  console.error(`build-wordlist-es: ${message}`);
  process.exit(1);
}
