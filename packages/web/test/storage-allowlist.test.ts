import { describe, expect, it } from "vitest";
import { storageViolations, type StorageDump } from "./storage-allowlist";

/** What Safari's walk-through actually found after a reload. */
const OBSERVED: StorageDump = {
  sessionStorage: { "sveltekit:scroll": '{"1791975655123":{"x":0,"y":0}}', "sveltekit:snapshot": "{}" },
  localStorage: {},
  indexedDB: [],
  cacheStorage: [],
  opfs: [],
  cookies: "",
  windowName: "",
  historyState: { "sveltekit:history": 1791975655123, "sveltekit:navigation": 1791975655123 },
};

const KEY = "6dcrGKMK3FURH0-OvouBNdq3tAlQbkRbGdvF54wb5zs";
const with_ = (patch: Partial<StorageDump>): StorageDump => ({ ...OBSERVED, ...patch });
const session = (extra: Record<string, string>) => with_({ sessionStorage: { ...OBSERVED.sessionStorage, ...extra } });

describe("the storage allowlist", () => {
  it("accepts what SvelteKit writes, and empty storage", () => {
    expect(storageViolations(OBSERVED, [KEY])).toEqual([]);
    expect(storageViolations(with_({ sessionStorage: {}, historyState: null }), [KEY])).toEqual([]);
  });

  const refused: [string, StorageDump][] = [
    ["any other sessionStorage key", session({ invite: "x" })],
    ["a snapshot that captured something", session({ "sveltekit:snapshot": '{"1":["tortilla","de"]}' })],
    ["a scroll entry holding text", session({ "sveltekit:scroll": '{"1":{"x":0,"y":"k"}}' })],
    ["a scroll entry with an extra field", session({ "sveltekit:scroll": '{"1":{"x":0,"y":0,"k":1}}' })],
    ["a scroll key that is not an index", session({ "sveltekit:scroll": '{"k":{"x":0,"y":0}}' })],
    ["a scroll value that is not JSON", session({ "sveltekit:scroll": "nope" })],
    ["anything in localStorage", with_({ localStorage: { a: "1" } })],
    ["an IndexedDB database", with_({ indexedDB: ["vitrina"] })],
    ["a Cache Storage cache", with_({ cacheStorage: ["v1"] })],
    ["an OPFS entry", with_({ opfs: ["f"] })],
    ["a cookie", with_({ cookies: "a=1" })],
    ["window.name", with_({ windowName: "x" })],
    ["history.state with a page URL", with_({ historyState: { "sveltekit:history": 1, "sveltekit:pageurl": "https://x/v/" } })],
  ];
  for (const [what, dump] of refused) {
    it(`refuses ${what}`, () => {
      expect(storageViolations(dump)).not.toEqual([]);
    });
  }

  it("names the place and the exact problem, one finding per place", () => {
    expect(storageViolations(session({ "vitrina:canary": "x" }))).toEqual(['sessionStorage key "vitrina:canary" is not permitted']);
    expect(storageViolations(session({ "sveltekit:snapshot": '{"1":[1]}' }))).toEqual(['sessionStorage key "sveltekit:snapshot" is not empty']);
    expect(storageViolations(with_({ localStorage: { a: "1", b: "2" } }))).toEqual(["localStorage holds 2 keys"]);
  });

  it("a secret in window.name is exactly one finding, naming window.name, never the value", () => {
    const found = storageViolations(with_({ windowName: KEY }), ["v=1&k=" + KEY, KEY]);
    expect(found).toEqual(["window.name holds secret #1"]);
    expect(found.join(" ")).not.toContain(KEY);
  });

  it("finds a secret in any place, and never prints it", () => {
    const placed: [string, StorageDump][] = [
      ["sessionStorage value", session({ note: KEY })],
      ["scroll entry", session({ "sveltekit:scroll": `{"1":{"x":0,"y":0},"${KEY}":1}` })],
      ["localStorage", with_({ localStorage: { a: KEY } })],
      ["IndexedDB name", with_({ indexedDB: [KEY] })],
      ["cache name", with_({ cacheStorage: [KEY] })],
      ["OPFS entry", with_({ opfs: [KEY] })],
      ["cookie", with_({ cookies: `k=${KEY}` })],
      ["history.state", with_({ historyState: { "sveltekit:history": 1, url: `/v/#k=${KEY}` } })],
    ];
    for (const [what, dump] of placed) {
      const found = storageViolations(dump, [KEY]);
      expect(found, what).toHaveLength(1);
      expect(found[0], what).toMatch(/holds secret #0$/);
      expect(found.join(" "), what).not.toContain(KEY);
    }
  });

  it("does not print a key name that is itself the secret", () => {
    const found = storageViolations(session({ [KEY]: "1" }), [KEY]);
    expect(found).toEqual(["sessionStorage a key whose name is a secret holds secret #0"]);
  });

  it("finds nothing in clean storage, secrets or not", () => {
    const clean = with_({ historyState: { "sveltekit:history": 1, "sveltekit:states": {} } });
    expect(storageViolations(clean, [KEY])).toEqual([]);
  });
});

describe("the owner allowlist (flows §1.1)", () => {
  const TOKEN = "A".repeat(43);
  const owner = session({ "vitrina:owner:token": TOKEN, "vitrina:owner:expires_at": "2026-10-29T12:00:00Z" });

  it("permits the token and its expiry on owner pages only", () => {
    expect(storageViolations(owner, [], { owner: true })).toEqual([]);
    expect(storageViolations(owner)).toEqual([
      'sessionStorage key "vitrina:owner:token" is not permitted',
      'sessionStorage key "vitrina:owner:expires_at" is not permitted',
    ]);
  });

  it("refuses either key holding anything but its shape", () => {
    expect(storageViolations(session({ "vitrina:owner:token": "a@b.c" }), [], { owner: true })).toEqual(['sessionStorage key "vitrina:owner:token" is not a token']);
    expect(storageViolations(session({ "vitrina:owner:expires_at": "tomorrow" }), [], { owner: true })).toEqual([
      'sessionStorage key "vitrina:owner:expires_at" is not an RFC 3339 UTC time',
    ]);
  });

  it("refuses any third owner key, an email, a password or a proof", () => {
    expect(storageViolations(session({ "vitrina:owner:email": "a@b.c" }), [], { owner: true })).toEqual([
      'sessionStorage key "vitrina:owner:email" is not permitted',
    ]);
    const found = storageViolations(with_({ localStorage: { k: "hunter2hunter2" } }), ["hunter2hunter2"], { owner: true });
    expect(found).toEqual(["localStorage holds secret #0"]);
  });
});

describe("the recipient invite allowlist (flows §4.7)", () => {
  const FRAGMENT = `#v=1&a=AAAAAAAAAAAAAAAAAAAAAA&t=${"T".repeat(43)}&k=${KEY}`;
  const INVITE = "vitrina:recipient:invite";
  const secrets = [FRAGMENT, KEY];

  it("permits exactly the fragment under its one key, only when named, and does not search it", () => {
    expect(storageViolations(session({ [INVITE]: FRAGMENT }), secrets, { recipientInvite: FRAGMENT })).toEqual([]);
    // Not named: the same entry is a secret in storage.
    expect(storageViolations(session({ [INVITE]: FRAGMENT }), secrets)).toEqual([`sessionStorage key "${INVITE}" holds secret #0, #1`]);
  });

  it("finds K_invite under any second key, even with the entry permitted", () => {
    const dump = session({ [INVITE]: FRAGMENT, "vitrina:other": KEY });
    expect(storageViolations(dump, secrets, { recipientInvite: FRAGMENT })).toEqual(['sessionStorage key "vitrina:other" holds secret #1']);
  });

  it("finds K_invite anywhere else: localStorage, IndexedDB, cookies, window.name, history.state", () => {
    const permitted = { [INVITE]: FRAGMENT };
    const elsewhere: [StorageDump, string][] = [
      [with_({ sessionStorage: { ...OBSERVED.sessionStorage, ...permitted }, localStorage: { a: KEY } }), "localStorage holds secret #1"],
      [with_({ sessionStorage: { ...OBSERVED.sessionStorage, ...permitted }, indexedDB: [KEY] }), "IndexedDB holds secret #1"],
      [with_({ sessionStorage: { ...OBSERVED.sessionStorage, ...permitted }, cookies: `k=${KEY}` }), "document.cookie holds secret #1"],
      [with_({ sessionStorage: { ...OBSERVED.sessionStorage, ...permitted }, windowName: KEY }), "window.name holds secret #1"],
      [with_({ sessionStorage: { ...OBSERVED.sessionStorage, ...permitted }, historyState: { "sveltekit:history": 1, k: KEY } }), "history.state holds secret #1"],
    ];
    for (const [dump, finding] of elsewhere) expect(storageViolations(dump, secrets, { recipientInvite: FRAGMENT })).toEqual([finding]);
  });

  it("refuses a different value under the invite key: another fragment, or one with K_album added", () => {
    const other = FRAGMENT.replace("k=", "k=x");
    expect(storageViolations(session({ [INVITE]: other }), [], { recipientInvite: FRAGMENT })).toEqual([`sessionStorage key "${INVITE}" is not the invite's fragment`]);
  });
});
