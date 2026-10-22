import { describe, expect, it } from "vitest";
import { INVITE_KEY, inviteStore } from "./recipient-session";

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const throwing = () => {
  throw new DOMException("denied", "SecurityError");
};

describe("the recipient's invite store (flows §4.7)", () => {
  it("writes one key, the fragment exactly as given, and reads it back", () => {
    const s = memory();
    const store = inviteStore(() => s);
    store.write("#v=1&a=x&t=y&k=z");
    expect([...s.map.entries()]).toEqual([[INVITE_KEY, "#v=1&a=x&t=y&k=z"]]);
    expect(store.read()).toBe("#v=1&a=x&t=y&k=z");
  });

  it("clear removes it, and a later read is null", () => {
    const s = memory();
    const store = inviteStore(() => s);
    store.write("#v=1&a=x&t=y");
    store.clear();
    expect(s.map.size).toBe(0);
    expect(store.read()).toBeNull();
  });

  it("a new invite replaces the old one: one entry, never two", () => {
    const s = memory();
    const store = inviteStore(() => s);
    store.write("#v=1&a=one&t=y");
    store.write("#v=1&a=two&t=y");
    expect([...s.map.values()]).toEqual(["#v=1&a=two&t=y"]);
  });

  it("unavailable storage reads as nothing and never throws", () => {
    const store = inviteStore(throwing as never);
    expect(store.read()).toBeNull();
    expect(() => store.write("#v=1&a=x&t=y")).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it("a refused write clears the previous invite rather than leaving it in place of this one", () => {
    const s = memory();
    s.map.set(INVITE_KEY, "#v=1&a=old&t=y");
    const store = inviteStore(() => ({
      ...s,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
    }));
    store.write("#v=1&a=new&t=y");
    expect(s.map.size).toBe(0);
  });
});
