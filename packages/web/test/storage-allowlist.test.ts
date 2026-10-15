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
