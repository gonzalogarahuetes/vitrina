#!/usr/bin/env node
//
// Spec citation checker — report-only, no dependencies, Node stdlib only.
//
// The documents in spec/ cite each other by section number, constantly:
// "brief §6", "encryption spec §6.2", "vitrina-server-architecture.md §8",
// "§7.5". Those citations go stale. A section number that points at nothing is
// bad; a section number that points at the *wrong thing* is worse, because it
// reads as authoritative. Architecture §9 records the canonical instance:
// §2 and §8 cited "non-negotiables #26 and #27" when brief §6 had fifteen
// items, neither number ever resolved, and it was found by hand months later.
//
// That is mechanically checkable, so it is a failing build rather than a
// review burden. Same move as scripts/check-forbidden-constructions.sh.
//
// WHAT THIS CHECKS — these fail the build
//   UNRESOLVED-DOC        the cited document filename does not exist in spec/
//   UNRESOLVED-SECTION    the citation NAMES a document, and that document
//                         defines no such section
//   LIST-OVERFLOW         a #N into brief §6's list where N exceeds its length
// and these are reported without failing:
//   UNRESOLVED-BARE-SECTION  a bare "§10.1" that the citing document does not
//                         define — under-specified rather than wrong, since a
//                         reader resolves it from the sentence
//   UNPARSED              a § the parser did not understand
//   LIST-OVERFLOW-QUOTED  an overflowing #N sitting in prose *about* citation
//                         rather than in a citation — spec/ discusses the
//                         historical #26/#27 bug, and a quotation of a broken
//                         citation is not itself one
//
// WHY THE BLOCKING SET IS THE NARROW ONE
//   A citation that names a document is a claim only the author can get wrong,
//   and it is the shape that pointed at "non-negotiables #26 and #27". A bare
//   §N is house style. Blocking on house style would mean a prose citation can
//   hold up a Rust commit, which is backwards: the code is the thing that
//   cannot be behind. Advisory findings still print on every run, so the count
//   stays visible and can be driven down deliberately rather than under duress.
//
// WHAT THIS DOES NOT CHECK
//   Whether a cited section is *relevant*. Only that it exists. Relevance is
//   a reading problem, and a checker that guessed at it would be wrong in
//   both directions.
//   Prose counts ("five routes" above a six-row table). Out of scope.
//
// WHY UNPARSED IS REPORTED AT ALL
//   Without it this script can cover 60% of the citations in spec/ and still
//   print green, which is worse than not having it — it would retire a
//   review habit and replace it with less. Coverage has to be visible. Same
//   reasoning as the log projection in api-sketch §1.2 being a whitelist
//   rather than a filter: what is not handled must be named, not dropped.
//
// Run locally with: pnpm check:citations

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Normally spec/. The override exists so the verify-by-violation drill can run
// against a throwaway copy: the discipline this repo applies to the ESLint
// boundary rule and the forbidden-constructions gate is to prove a check fails
// before trusting that it passes, and spec/ is not a place to stage breakage.
// CI does not set it.
const SPEC_DIR = process.env.VITRINA_SPEC_DIR
	? path.resolve(process.env.VITRINA_SPEC_DIR)
	: path.join(REPO_ROOT, 'spec');

// ---------------------------------------------------------------------------
// Alias map. How the documents actually refer to each other in prose.
//
// Derived by surveying every § occurrence in spec/ rather than by guessing:
// "brief", "encryption spec", "schema", "architecture", "track-b-plan" are
// the forms in use, alongside bare `vitrina-*.md` filenames. Longest alias
// wins, so "project brief" is matched before "brief" — both land on the same
// file, but the precedence rule matters for any future pair that does not.
//
// Add an alias when a document starts being cited a new way. Do not remove
// one: a citation form that stops being recognised silently becomes UNPARSED,
// and UNPARSED does not fail the build.
// ---------------------------------------------------------------------------
const ALIASES = {
	'project brief': 'vitrina-project-brief.md',
	brief: 'vitrina-project-brief.md',
	'encryption spec': 'vitrina-encryption-spec.md',
	'encryption envelope spec': 'vitrina-encryption-spec.md',
	'invite spec': 'vitrina-invite-spec.md',
	'invite payload spec': 'vitrina-invite-spec.md',
	'schema doc': 'vitrina-schema.md',
	'schema document': 'vitrina-schema.md',
	schema: 'vitrina-schema.md',
	'server architecture': 'vitrina-server-architecture.md',
	architecture: 'vitrina-server-architecture.md',
	'api sketch': 'vitrina-api-sketch.md',
	'api-sketch': 'vitrina-api-sketch.md',
	'api surface sketch': 'vitrina-api-sketch.md',
	roadmap: 'vitrina-roadmap.md',
	'track-b-plan': 'vitrina-track-b-plan.md',
	'track b plan': 'vitrina-track-b-plan.md',
	'phase-0-plan': 'vitrina-phase-0-plan.md',
	'phase 0 plan': 'vitrina-phase-0-plan.md',
};

// The document whose numbered list `#N` references are checked against, and
// the section that list lives in. Both are data, not assumptions: the item
// count is extracted from the document at run time.
const LIST_DOC = 'vitrina-project-brief.md';
const LIST_SECTION = '6';

// How far back from a `#N` token to look for the thing that gives it a
// referent. Only the text immediately to the left is consulted (see
// parseHashRefs), so this is a bound on that lookbehind, not a proximity
// window: markdown emphasis and a possessive are all that may intervene.
const HASH_LOOKBEHIND = 60;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Blank out fenced code blocks, preserving length so byte offsets still map
 * to the original line numbers. A § inside a code sample is not a citation.
 */
function maskFences(text) {
	const out = text.split('');
	const fence = /^(\s*)(```+|~~~+)/;
	const lines = text.split('\n');
	let offset = 0;
	let inFence = false;
	let closer = null;
	for (const line of lines) {
		const m = fence.exec(line);
		if (!inFence && m) {
			inFence = true;
			closer = m[2][0];
		} else if (inFence && m && m[2][0] === closer) {
			inFence = false;
			closer = null;
		} else if (inFence) {
			for (let i = 0; i < line.length; i++) out[offset + i] = ' ';
		}
		offset += line.length + 1;
	}
	return out.join('');
}

function loadDocs() {
	if (!fs.existsSync(SPEC_DIR)) {
		console.error(`check-spec-citations: ${SPEC_DIR} does not exist`);
		process.exit(1);
	}
	const docs = new Map();
	for (const name of fs.readdirSync(SPEC_DIR).sort()) {
		if (!name.endsWith('.md')) continue;
		const raw = fs.readFileSync(path.join(SPEC_DIR, name), 'utf8');
		// Newlines become spaces so a citation whose qualifier sits on the
		// previous line ("brief\n§3, §11") reads as one string. Replacing
		// rather than stripping keeps every offset aligned with `raw`.
		const buf = maskFences(raw).replace(/\n/g, ' ');
		docs.set(name, { name, raw, buf, sections: indexSections(raw), lineStarts: lineStarts(raw) });
	}
	return docs;
}

function lineStarts(raw) {
	const starts = [0];
	for (let i = 0; i < raw.length; i++) if (raw[i] === '\n') starts.push(i + 1);
	return starts;
}

function lineOf(doc, offset) {
	const s = doc.lineStarts;
	let lo = 0;
	let hi = s.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (s[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo + 1;
}

// ---------------------------------------------------------------------------
// Step 2 — heading index
//
//   ## 6. Non-negotiables            -> 6
//   ### 9.1 Two auth mechanisms      -> 9.1
//   ### 6.6.1 The parameter-fetch    -> 6.6.1
//   #### What a validation failure   -> unnumbered, ignored
//
// The trailing dot is present at some levels and absent at others; both are
// accepted. Unnumbered headings are not addressable by number and so are not
// indexed — a citation cannot name them.
// ---------------------------------------------------------------------------
function indexSections(raw) {
	const sections = new Set();
	const re = /^#{1,6}[ \t]+(\d+(?:\.\d+)*)\.?[ \t]/gm;
	let m;
	while ((m = re.exec(raw)) !== null) sections.add(m[1]);
	return sections;
}

/**
 * Count the items in the numbered list under `sectionNum` of `doc`.
 *
 * The list in brief §6 runs 1..17 continuously but is broken up by `###`
 * subheadings, so "the items under this ## section, up to the next ## " is
 * the correct span. The count is the largest literal ordinal written, not the
 * number of list lines: an author renumbering by hand is exactly the failure
 * this check exists for, and the largest ordinal is what a citation can
 * legitimately reach.
 */
function countListItems(doc, sectionNum) {
	const lines = doc.raw.split('\n');
	const escaped = sectionNum.replace(/\./g, '\\.');
	const startRe = new RegExp(`^(#{1,6})[ \\t]+${escaped}\\.?[ \\t]`);
	let depth = null;
	let max = 0;
	let seen = false;
	for (const line of lines) {
		if (depth === null) {
			const m = startRe.exec(line);
			if (m) depth = m[1].length;
			continue;
		}
		const h = /^(#{1,6})[ \t]+/.exec(line);
		if (h && h[1].length <= depth) break; // next section at the same level or higher
		const item = /^[ \t]*(\d+)\.[ \t]/.exec(line);
		if (item) {
			seen = true;
			max = Math.max(max, Number(item[1]));
		}
	}
	return seen ? max : null;
}

// ---------------------------------------------------------------------------
// Step 1 — citation parsing
// ---------------------------------------------------------------------------

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

// Word separators inside a multi-word alias are interchangeable: the documents
// write both "invite spec §7.3" and "invite-spec §7.3", and reading the second
// as a self-reference misattributes it to the citing document.
const aliasBody = (alias) => alias.split(/[\s-]+/).map(escapeRe).join('[\\s-]+');

const ALIAS_PATTERNS = Object.keys(ALIASES)
	// Longest first so "project brief" beats "brief".
	.sort((a, b) => b.length - a.length)
	.map((alias) => ({
		alias,
		file: ALIASES[alias],
		// The alias must sit at the very end of the preceding text, allowing a
		// possessive and one trailing separator: "per brief §6", "(schema §3",
		// "brief's §6", "encryption spec, §2".
		re: new RegExp(
			`(?:^|[^a-z0-9])${aliasBody(alias)}(?:'s|’s)?\\s*[(,:;—–]?\\s*$`,
			'i'
		),
	}));

// Bare `vitrina-*.md` filenames are citations too, and are resolved against
// the real directory listing rather than the alias map.
function filePatternFor(names) {
	return names.map((name) => ({
		alias: name,
		file: name,
		re: new RegExp(`(?:^|[^a-z0-9-])${escapeRe(name)}(?:'s|’s)?\\s*[(,:;—–]?\\s*$`, 'i'),
	}));
}

/** Strip markdown noise from a slice used only for suffix matching. */
function cleanBefore(s) {
	return s.replace(/[`*_>|"\u201c\u201d\[\]]/g, '').replace(/\s+/g, ' ');
}

// A citation whose document is named by filename, where that filename is not
// in spec/. Without this, an unknown document degrades silently into a
// self-reference: rename a document and every bare-filename citation to it
// gets quietly re-pointed at the document doing the citing. That is the exact
// failure mode this script exists to catch, so it must not be the script's own
// behaviour.
//
// Deliberately limited to the `*.md` form, which is unambiguous. Detecting an
// unknown *prose* alias ("billing spec \u00a72") was tried and removed: the shapes
// that catch it also catch "a written spec (\u00a78)" and "inside this document \u2014
// \u00a77.3's steps", which are self-references in prose, not document names. An
// unrecognised prose alias therefore falls through to a self-reference and, in
// almost every case, still fails as UNRESOLVED-SECTION \u2014 with a less precise
// reason. The fix for that is to add the alias to ALIASES, which is why that
// map is documented as append-only.
const MD_FILENAME = /(?:^|[^a-z0-9._-])([a-z0-9][a-z0-9._-]*\.md)(?:'s|\u2019s)?\s*[(,:;\u2014\u2013]?\s*$/i;

function looksLikeDocRef(before) {
	const m = MD_FILENAME.exec(before);
	return m ? m[1] : null;
}

/**
 * Parse every citation in one document.
 *
 * Returns { citations, unparsed }. A citation is:
 *   { offset, end, line, text, file | null, alias, sections: [..], via }
 * where `via` records how the document was determined — 'alias', 'filename',
 * 'continuation' or 'self' — so the report can explain itself.
 */
function parseCitations(doc, fileNames) {
	const filePatterns = filePatternFor(fileNames);
	const citations = [];
	const unparsed = [];
	const consumed = new Set();

	for (let i = 0; i < doc.buf.length; i++) {
		if (doc.buf[i] !== '\u00a7') continue;
		if (consumed.has(i)) continue;

		const rest = doc.buf.slice(i);
		const head = /^\u00a7\s*(\d+(?:\.\d+)*)/.exec(rest);
		if (!head) {
			unparsed.push({ offset: i, line: lineOf(doc, i), text: doc.buf.slice(i, i + 40).trim() });
			continue;
		}

		const sections = [head[1]];
		let len = head[0].length;

		// Ranges and alternates: "§1–§6", "§9–§9.3", "§7.1–§7.4", "§9/§9.1".
		// Both endpoints are checked. The inner § is marked consumed so it is
		// not re-parsed as a standalone citation — which would otherwise lose
		// the document qualifier and be resolved against the wrong file.
		const tailRe = /^\s*([\u2013\u2014\/-])\s*(\u00a7\s*)?(\d+(?:\.\d+)*)/;
		let more;
		while ((more = tailRe.exec(rest.slice(len))) !== null) {
			// A hyphen followed by a word ("§11-independent") is not a range;
			// the regex already requires digits. Require an explicit § for the
			// slash form so "§7.5/login" style paths cannot masquerade.
			if (more[1] === '/' && !more[2]) break;
			const innerAt = i + len + more[0].indexOf('\u00a7');
			if (more[2]) consumed.add(innerAt);
			sections.push(more[3]);
			len += more[0].length;
		}

		// A trailing item label — "track-b-plan §3 B.6". The label names an
		// item inside the section; only the section number is verified.
		let itemLabel = null;
		const label = /^\s+([A-Z]\.?\d+(?:\.\d+)*)\b/.exec(rest.slice(len));
		if (label) {
			itemLabel = label[1];
			len += label[0].length;
		}

		// --- which document?
		const before = cleanBefore(doc.buf.slice(Math.max(0, i - 60), i));
		let file = null;
		let alias = null;
		let via = null;

		for (const p of [...ALIAS_PATTERNS, ...filePatterns]) {
			if (p.re.test(before)) {
				file = p.file;
				alias = p.alias;
				via = ALIASES[p.alias] ? 'alias' : 'filename';
				break;
			}
		}

		// The citation names a document, but not one that resolves. Recorded as
		// the unresolvable name so the report says so, rather than quietly
		// re-pointing the citation at the document it appears in.
		if (!file) {
			const unknown = looksLikeDocRef(before);
			if (unknown) {
				file = unknown;
				alias = null;
				via = 'unknown-doc';
			}
		}

		// Continuation: "brief §9.1 (why two auth mechanisms), §9.2, and §9.3".
		// A bare § joined to the previous citation by a comma, semicolon or
		// conjunction inherits that citation's document. This is not a nicety
		// — vitrina-schema.md:15 cites brief §9.1, §9.2 and §9.3 that way, and
		// schema defines no §9.x, so reading them as self-references would
		// invent three failures that are not there.
		//
		// What counts as enumeration glue is the whole difficulty, and both
		// halves of this test are load-bearing:
		//
		//   comma form  "brief \u00a79.1 (why two auth mechanisms), \u00a79.2"
		//               a comma, optionally "and"/"or", with a parenthetical
		//               gloss allowed but no sentence-ending punctuation.
		//   bare form   "Brief \u00a711 and \u00a712"
		//               the conjunction and nothing else.
		//
		// The bare form must be *only* the conjunction. api-sketch \u00a77.10 reads
		// "brief \u00a712 closed the account model and \u00a77.5 states the body", where
		// \u00a77.5 is a self-reference; inheriting "brief" across that "and"
		// invents a failure. Words between the conjunction and the previous
		// citation mean a new clause has started, not a list continuing.
		if (!file) {
			const prev = citations[citations.length - 1];
			if (prev && i - prev.end <= 40) {
				const between = doc.buf.slice(prev.end, i);
				const commaForm = /^[^.;:!?]*,\s*(?:and|or)?\s*$/i;
				const bareForm = /^[\s)\]'\u2019"]*(?:and|or)\s*$/i;
				if (commaForm.test(between) || bareForm.test(between)) {
					file = prev.file;
					alias = prev.alias;
					via = 'continuation';
				}
			}
		}

		// No qualifier at all: the citation is into this same document.
		if (!file) {
			file = doc.name;
			alias = null;
			via = 'self';
		}

		citations.push({
			offset: i,
			end: i + len,
			line: lineOf(doc, i),
			text: doc.buf.slice(i, i + len).replace(/\s+/g, ' ').trim(),
			file,
			alias,
			via,
			sections,
			itemLabel,
		});
	}

	return { citations, unparsed };
}

/**
 * Find every `#N` list reference and bind it to a referent.
 *
 * Binding is by ADJACENCY, not proximity, and that is the whole difficulty.
 * "brief §6 #16" and "non-negotiable #15" are references into a list. "PR #438"
 * and "checklist item #2" are not, and a rule that merely looked for a brief §6
 * citation somewhere in the preceding 80 characters catches all four — the
 * documents put those tokens close together. So a `#N` acquires a referent only
 * from what sits immediately to its left:
 *
 *   "non-negotiable(s) #N"  -> brief §6, which is what the word denotes here
 *   "<citation> #N"         -> that citation's document and section, so
 *                              "architecture §9's #26" is about architecture's
 *                              list and the brief's count does not govern it
 *   "#M and #N"             -> inherits #M's referent, for enumerated pairs
 *   anything else           -> no referent; not a list reference at all
 */
function parseHashRefs(doc, citations) {
	const refs = [];
	const re = /#(\d+)\b/g;
	let m;
	while ((m = re.exec(doc.buf)) !== null) {
		const at = m.index;
		// Markdown heading ("## 6.") never matches — a digit must follow '#'.
		// A link anchor ("](#6-non-negotiables)") is not a citation.
		if (at > 0 && doc.buf[at - 1] === '(') continue;

		// Text between a candidate referent and the '#', ignoring markdown
		// emphasis, brackets and a possessive: "§9's #26", "**#16**".
		const gap = "[\\s*_`)\\]'’]*";
		const before = doc.buf.slice(Math.max(0, at - HASH_LOOKBEHIND), at);

		let target = null;
		let why = null;

		// "#M and #N" — an enumerated pair shares one referent.
		const chain = new RegExp(`#(\\d+)${gap}(?:,${gap})?(?:and|or)?${gap}$`, 'i').exec(before);
		if (chain) {
			const prior = refs.find((r) => r.n === Number(chain[1]) && at - r.offset <= HASH_LOOKBEHIND);
			if (prior && prior.target) {
				target = prior.target;
				why = `enumerated with #${chain[1]}`;
			}
		}

		// "non-negotiable #N" — the word names the brief's list by convention.
		if (!target && new RegExp(`non-negotiables?${gap}$`, 'i').test(before)) {
			target = { file: LIST_DOC, section: LIST_SECTION };
			why = 'the adjacent word "non-negotiable"';
		}

		// "<citation> #N" — the citation names the list being indexed into.
		if (!target) {
			for (const c of citations) {
				if (c.end > at) break;
				if (c.end <= at && new RegExp(`^${gap}$`).test(doc.buf.slice(c.end, at))) {
					target = { file: c.file, section: c.sections[0] };
					why = `the adjacent citation ${c.text}`;
				}
			}
		}

		refs.push({ offset: at, line: lineOf(doc, at), n: Number(m[1]), token: `#${m[1]}`, target, why });
	}
	return refs;
}

// Citation-about-citation vocabulary. spec/ discusses the historical #26/#27
// bug in prose — "§2 and §8 cited non-negotiables #26 and #27", "the failure
// architecture §9 had to clean up as non-negotiables #26 and #27" — and those
// mentions are indistinguishable from live citations by grammar alone: they
// *are* quotations of citations, which is why they read like them.
//
// Where this vocabulary surrounds an overflowing #N, the finding is reported
// but does not fail the build. It is not suppressed: a check that silently
// dropped them would be claiming coverage it does not have, the same objection
// that makes UNPARSED a reported class rather than a filtered one. A genuine
// stale citation — "non-negotiable #26 forbids X" — carries none of these words
// and still fails.
// Binding needs adjacency, but "is this passage discussing citations" is a
// property of the paragraph, so this window is wider than HASH_LOOKBEHIND.
const METACITATION_CONTEXT = 200;
const METACITATION =
	/\b(?:cite|cites|cited|citing|citation|citations|references?|resolv(?:e|es|ed|ing)|dangling|renumber\w*|(?:was|were) removed|(?:was|were) introduced)\b/i;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const docs = loadDocs();
const fileNames = [...docs.keys()];

if (fileNames.length === 0) {
	console.error('check-spec-citations: no .md files in spec/; nothing to check');
	process.exit(1);
}

// An alias pointing at a file that is not there is a bug in this script, not
// in the documents. Fail loudly rather than reporting every citation through
// that alias as UNRESOLVED-DOC.
const brokenAliases = Object.entries(ALIASES).filter(([, f]) => !docs.has(f));
if (brokenAliases.length > 0) {
	console.error('check-spec-citations: alias map points at files that do not exist in spec/:');
	for (const [a, f] of brokenAliases) console.error(`  "${a}" -> ${f}`);
	process.exit(1);
}

const listDoc = docs.get(LIST_DOC);
const listCount = listDoc ? countListItems(listDoc, LIST_SECTION) : null;
if (listCount === null) {
	console.error(
		`check-spec-citations: found no numbered list under §${LIST_SECTION} of ${LIST_DOC}; ` +
			'LIST-OVERFLOW cannot be checked. Fix the extractor rather than hardcoding a count.'
	);
	process.exit(1);
}

const findings = [];
let resolved = 0;
let citationCount = 0;

for (const doc of docs.values()) {
	const { citations, unparsed } = parseCitations(doc, fileNames);
	citationCount += citations.length;

	for (const c of citations) {
		const target = docs.get(c.file);
		if (!target) {
			findings.push({
				file: doc.name,
				line: c.line,
				cls: 'UNRESOLVED-DOC',
				citation: `${c.alias ?? ''} ${c.text}`.trim(),
				reason: `no such document in spec/: ${c.file}`,
			});
			continue;
		}
		let ok = true;
		for (const s of c.sections) {
			if (!target.sections.has(s)) {
				ok = false;
				// Severity turns on whether the citation NAMES a document.
				//
				// "brief \u00a76.6" is a claim about another document, and the author
				// is the only person who can be wrong about it. Those are the
				// citations that point confidently at nothing, and they block.
				//
				// A bare "\u00a710.1" in api-sketch is an under-specified citation, not
				// a false one: the reader resolves it from the sentence and only
				// the parser cannot. Two dozen of those are a house style this
				// script was written after, not a defect it discovered, and a red
				// build over them would hold up Rust commits that have nothing to
				// do with prose. Reported every run, never blocking.
				const named = c.via !== 'self';
				findings.push({
					file: doc.name,
					line: c.line,
					cls: named ? 'UNRESOLVED-SECTION' : 'UNRESOLVED-BARE-SECTION',
					citation: `${c.alias ?? ''} ${c.text}`.trim(),
					reason:
						`${c.file} defines no \u00a7${s}` +
						(c.via === 'self'
							? ' (no document named; resolved against the citing document)'
							: '') +
						(c.via === 'continuation' ? ' (document inherited from the preceding citation)' : ''),
				});
			}
		}
		if (ok) resolved++;
	}

	for (const u of unparsed) {
		findings.push({
			file: doc.name,
			line: u.line,
			cls: 'UNPARSED',
			citation: u.text,
			reason: 'the parser did not recognise this \u00a7 form',
		});
	}

	for (const r of parseHashRefs(doc, citations)) {
		if (!r.target) continue;
		if (r.target.file !== LIST_DOC || r.target.section !== LIST_SECTION) continue;
		if (r.n > listCount) {
			const context = doc.buf.slice(
				Math.max(0, r.offset - METACITATION_CONTEXT),
				r.offset + METACITATION_CONTEXT
			);
			const quoted = METACITATION.test(context);
			findings.push({
				file: doc.name,
				line: r.line,
				cls: quoted ? 'LIST-OVERFLOW-QUOTED' : 'LIST-OVERFLOW',
				citation: r.token,
				reason:
					`\u00a7${LIST_SECTION} of ${LIST_DOC} has ${listCount} items; bound via ${r.why}` +
					(quoted ? '; sits in prose about citation, so reported only' : ''),
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Step 4 — output
// ---------------------------------------------------------------------------

const HARD = new Set(['UNRESOLVED-DOC', 'UNRESOLVED-SECTION', 'LIST-OVERFLOW']);
const counts = new Map();
for (const f of findings) counts.set(f.cls, (counts.get(f.cls) ?? 0) + 1);
const hardCount = findings.filter((f) => HARD.has(f.cls)).length;

if (findings.length > 0) {
	const byFile = new Map();
	for (const f of findings) {
		if (!byFile.has(f.file)) byFile.set(f.file, []);
		byFile.get(f.file).push(f);
	}
	console.log('');
	console.log('spec citation check');
	console.log('');
	for (const [file, list] of [...byFile.entries()].sort()) {
		console.log(`spec/${file}`);
		for (const f of list.sort((a, b) => a.line - b.line)) {
			console.log(`  ${file}:${f.line}  ${f.cls}  ${f.citation}  \u2192 ${f.reason}`);
		}
		console.log('');
	}
	for (const cls of [
		'UNRESOLVED-DOC',
		'UNRESOLVED-SECTION',
		'LIST-OVERFLOW',
		'UNRESOLVED-BARE-SECTION',
		'LIST-OVERFLOW-QUOTED',
		'UNPARSED',
	]) {
		if (counts.has(cls)) {
			const tag = HARD.has(cls) ? 'fails the build' : 'reported only';
			console.log(`  ${String(counts.get(cls)).padStart(4)}  ${cls}  (${tag})`);
		}
	}
	console.log('');
	console.log(
		`  ${citationCount} citations parsed, ${resolved} resolved, ` +
			`across ${fileNames.length} documents in spec/`
	);
	console.log(`  \u00a7${LIST_SECTION} of ${LIST_DOC}: ${listCount} numbered items`);
	console.log('');
}

if (hardCount > 0) {
	console.log(
		`check-spec-citations: ${hardCount} citation${hardCount === 1 ? '' : 's'} ` +
			'names a document and points at nothing in it'
	);
	console.log('');
	console.log('A citation that points at nothing is a bug; a citation that names the wrong');
	console.log('document is worse, because it reads as authoritative. Fix the citation in the');
	console.log('document — do not widen this check to accept it.');
	process.exit(1);
}

if (findings.length === 0) {
	console.log(
		`check-spec-citations: clean \u2014 ${resolved}/${citationCount} citations resolved ` +
			`across ${fileNames.length} documents`
	);
}
process.exit(0);
