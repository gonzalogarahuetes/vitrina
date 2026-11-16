/*
 * The browser's Back on the recipient path (lib/history.ts): grid → viewer,
 * and nothing else adds an entry. The whole session against the fake relay,
 * history followed into a fake session history.
 */
import { describe, expect, it } from "vitest";
import { FakeHistory, follow } from "$lib/history.test-support";
import { PASS_FRAGMENT, PASSPHRASE_WORDS, QR_FRAGMENT, harness, settle } from "./harness.test-support";

type H = ReturnType<typeof harness>;
type O = { h: H; history: FakeHistory };

function at({ h, history }: O): string {
  expect(history.depth, `history's depth on ${h.screen().kind}`).toBe(h.session.depth);
  expect(history.onlyMarkers, "history.state holds nothing but SvelteKit's keys and the marker").toBe(true);
  const s = h.screen();
  if (s.kind === "album") return s.viewer !== null ? "viewer" : "grid";
  return s.kind;
}

async function onGrid(history = new FakeHistory(), fragment = QR_FRAGMENT): Promise<O> {
  const h = harness();
  if (fragment === PASS_FRAGMENT) h.album.kind = "passphrase";
  const fresh = history.entries.length === 1;
  follow(h.session, history);
  const o = { h, history };
  h.session.start(fragment);
  await settle();
  if (fragment === PASS_FRAGMENT) {
    expect(at(o)).toBe("passphrase");
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    await settle();
  }
  expect(at(o)).toBe("onboarding");
  h.session.enterGrid();
  await settle();
  expect(at(o)).toBe("grid");
  expect(history.index).toBe(0);
  if (fresh) expect(history.depths, "nothing before the grid added an entry").toEqual([0]);
  return o;
}

async function back(o: O): Promise<string> {
  o.history.back();
  await settle();
  return at(o);
}

async function act(o: O, f: () => void): Promise<string> {
  f();
  await settle();
  return at(o);
}

describe("Back on the recipient path", () => {
  for (const [name, fragment] of [
    ["QR", QR_FRAGMENT],
    ["passphrase", PASS_FRAGMENT],
  ] as const) {
    it(`${name}: grid → viewer; Back closes the viewer; Back leaves the app`, async () => {
      const o = await onGrid(new FakeHistory(), fragment);
      expect(await act(o, () => o.h.session.openViewer(0))).toBe("viewer");
      expect(o.history.depths).toEqual([0, 1]);
      expect(await back(o)).toBe("grid");
      expect(o.h.pictures.filter((p) => p.closed > 0)).toHaveLength(1);
      o.history.back();
      await settle();
      expect(o.history.left).toBe(true);
    });
  }

  it("the viewer opened and closed 20 times with its own control, then one Back leaves the app", async () => {
    const o = await onGrid();
    for (let i = 0; i < 20; i++) {
      expect(await act(o, () => o.h.session.openViewer(i % 2))).toBe("viewer");
      expect(await act(o, () => o.h.session.closeViewer())).toBe("grid");
    }
    expect(o.history.entries.length).toBeLessThanOrEqual(2);
    expect(o.history.index).toBe(0);
    o.history.back();
    await settle();
    expect(o.history.left).toBe(true);
  });

  it("a reload on the viewer comes back to the grid's entry; Forward reopens nothing; Back leaves", async () => {
    const before = await onGrid();
    await act(before, () => before.h.session.openViewer(0));
    const history = new FakeHistory(before.history.entries, before.history.index);
    const o = await onGrid(history);
    expect(history.index).toBe(0);
    history.forward();
    await settle();
    expect(at(o), "Forward reopens nothing").toBe("grid");
    history.back();
    await settle();
    expect(history.left).toBe(true);
  });

  it("revoked from the viewer: the revoked screen at the top; Forward and Back reopen nothing", async () => {
    const o = await onGrid();
    o.h.override(`/v1/media/${o.h.album.media[1]?.id}/asset`, o.h.err(403, "ACCESS_REVOKED"));
    expect(await act(o, () => o.h.session.openViewer(1))).toBe("revoked");
    expect(o.history.index).toBe(0);
    o.history.forward();
    await settle();
    expect(at(o)).toBe("revoked");
    o.history.back();
    await settle();
    expect(o.history.left).toBe(true);
  });

  it("the dead page and the newer-version screen add nothing", async () => {
    for (const fragment of ["", "#v=2&x=y"]) {
      const h = harness();
      const { history } = follow(h.session);
      h.session.start(fragment);
      await settle();
      expect(h.session.depth).toBe(0);
      expect(history.depths).toEqual([0]);
    }
  });
});
