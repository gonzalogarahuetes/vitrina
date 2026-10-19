/*
 * What persistent browser storage may hold after the recipient path, judged
 * from a dump of real storage taken in a browser (invite spec §2.2 and §7
 * item 7). The browser check enumerates; this decides.
 *
 * SvelteKit writes two sessionStorage keys on every unload or hide, with no
 * option to stop it (persist_state in @sveltejs/kit's client.js):
 *   sveltekit:scroll   — history index → {x, y}. Numbers only.
 *   sveltekit:snapshot — {} unless a route exports `snapshot`, which
 *                        eslint.config.js forbids.
 * On owner pages, and only when the caller says so (`{ owner: true }`), two
 * more keys (flows §1.1, brief §12):
 *   vitrina:owner:token      — 43 characters of base64url
 *   vitrina:owner:expires_at — RFC 3339 UTC with a trailing Z
 * Nothing else may exist anywhere.
 *
 * One finding per place at most, naming the place. A place holding a secret
 * says so instead of its shape problem. No finding ever prints a stored value,
 * and a key name is printed only when it holds no secret: either may be the
 * secret itself.
 */

export type StorageDump = {
  readonly sessionStorage: Readonly<Record<string, string>>;
  readonly localStorage: Readonly<Record<string, string>>;
  /** indexedDB.databases() names. */
  readonly indexedDB: readonly string[];
  /** caches.keys(). */
  readonly cacheStorage: readonly string[];
  /** navigator.storage.getDirectory() entry names (the origin private file system). */
  readonly opfs: readonly string[];
  readonly cookies: string;
  readonly windowName: string;
  /** history.state, which the browser persists with the session. */
  readonly historyState: unknown;
};

const SCROLL = "sveltekit:scroll";
const SNAPSHOT = "sveltekit:snapshot";
const OWNER_TOKEN = "vitrina:owner:token";
const OWNER_EXPIRES = "vitrina:owner:expires_at";

export type AllowOptions = {
  /** An owner page: the owner token and its expiry are permitted in sessionStorage. */
  readonly owner?: boolean;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function scrollIsNumbersOnly(raw: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isRecord(parsed)) return false;
  return Object.entries(parsed).every(([index, pos]) => {
    if (!/^\d+$/.test(index) || !isRecord(pos)) return false;
    const keys = Object.keys(pos).sort();
    return keys.length === 2 && keys[0] === "x" && keys[1] === "y" && Number.isFinite(pos["x"]) && Number.isFinite(pos["y"]);
  });
}

/** SvelteKit's history entries: `sveltekit:*` keys only, holding numbers or an empty states object. */
function historyStateIsSvelteKitOnly(state: unknown): boolean {
  if (state === null || state === undefined) return true;
  if (!isRecord(state)) return false;
  return Object.entries(state).every(
    ([k, v]) => k.startsWith("sveltekit:") && (typeof v === "number" || (isRecord(v) && Object.keys(v).length === 0)),
  );
}

/** A place in storage: what it is called, what is wrong with its shape (if anything), and what to search. */
type Place = { readonly where: string; readonly problem: string | null; readonly content: string };

function places(dump: StorageDump, secrets: readonly string[], opts: AllowOptions): Place[] {
  const holds = (text: string) => secrets.some((s) => s !== "" && text.includes(s));
  const out: Place[] = [];

  for (const [key, value] of Object.entries(dump.sessionStorage)) {
    const name = holds(key) ? "a key whose name is a secret" : `key ${JSON.stringify(key.slice(0, 40))}`;
    const where = `sessionStorage ${name}`;
    let problem: string | null = null;
    if (key === SCROLL) problem = scrollIsNumbersOnly(value) ? null : "holds more than {index: {x, y}} numbers";
    else if (key === SNAPSHOT) problem = value === "{}" ? null : "is not empty";
    else if (opts.owner === true && key === OWNER_TOKEN) problem = /^[A-Za-z0-9_-]{43}$/.test(value) ? null : "is not a token";
    else if (opts.owner === true && key === OWNER_EXPIRES)
      problem = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ? null : "is not an RFC 3339 UTC time";
    else problem = "is not permitted";
    out.push({ where, problem, content: key + "\u0000" + value });
  }

  const n = (count: number, one: string, many: string) => `holds ${count} ${count === 1 ? one : many}`;
  const ls = Object.entries(dump.localStorage);
  out.push({ where: "localStorage", problem: ls.length === 0 ? null : n(ls.length, "key", "keys"), content: JSON.stringify(ls) });
  out.push({ where: "IndexedDB", problem: dump.indexedDB.length === 0 ? null : n(dump.indexedDB.length, "database", "databases"), content: JSON.stringify(dump.indexedDB) });
  out.push({ where: "Cache Storage", problem: dump.cacheStorage.length === 0 ? null : n(dump.cacheStorage.length, "cache", "caches"), content: JSON.stringify(dump.cacheStorage) });
  out.push({ where: "the origin private file system", problem: dump.opfs.length === 0 ? null : n(dump.opfs.length, "entry", "entries"), content: JSON.stringify(dump.opfs) });
  out.push({ where: "document.cookie", problem: dump.cookies === "" ? null : "is not empty", content: dump.cookies });
  out.push({ where: "window.name", problem: dump.windowName === "" ? null : "is not empty", content: dump.windowName });
  out.push({
    where: "history.state",
    problem: historyStateIsSvelteKitOnly(dump.historyState) ? null : "holds more than SvelteKit's indices",
    content: JSON.stringify(dump.historyState) ?? "",
  });
  return out;
}

/**
 * Every way the dump breaks the allowlist, one finding per place.
 * `secrets`: the fragment, the key in each spelling, the token. Empty means
 * the storage is as permitted.
 */
export function storageViolations(dump: StorageDump, secrets: readonly string[] = [], opts: AllowOptions = {}): string[] {
  const findings: string[] = [];
  for (const place of places(dump, secrets, opts)) {
    const hits = secrets.flatMap((s, i) => (s !== "" && place.content.includes(s) ? [`#${i}`] : []));
    if (hits.length > 0) findings.push(`${place.where} holds secret ${hits.join(", ")}`);
    else if (place.problem !== null) findings.push(`${place.where} ${place.problem}`);
  }
  return findings;
}
