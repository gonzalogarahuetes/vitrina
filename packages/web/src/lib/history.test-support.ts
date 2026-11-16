/*
 * A browser's session history for one document, as far as lib/history.ts can
 * see it: entries with a state each, pushState truncating what is ahead,
 * go() landing later (a task, as in a browser) and firing popstate, and a
 * Back past the first entry leaving the app. The first entry carries a
 * SvelteKit-like index, as the real one does, so a test can see it kept.
 */
import { DEPTH_KEY, depthOf, followHistory, type Backable } from "./history";

export const SVELTEKIT_STATE = { "sveltekit:history": 1791975655123, "sveltekit:navigation": 1791975655123 };

export class FakeHistory {
  entries: unknown[];
  index: number;
  /** Back went past the first entry: the app was left. */
  left = false;
  pushes = 0;
  gos: number[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(entries: unknown[] = [{ ...SVELTEKIT_STATE }], index = entries.length - 1) {
    this.entries = entries.map((e) => structuredClone(e));
    this.index = index;
  }

  get state(): unknown {
    return this.entries[this.index];
  }

  pushState(data: unknown, unused: string, url?: string): void {
    if (unused !== "" || url !== undefined) throw new Error("the URL must never change");
    this.pushes++;
    this.entries.splice(this.index + 1);
    this.entries.push(structuredClone(data));
    this.index++;
  }

  replaceState(data: unknown, unused: string, url?: string): void {
    if (unused !== "" || url !== undefined) throw new Error("the URL must never change");
    this.entries[this.index] = structuredClone(data);
  }

  go(delta: number): void {
    this.gos.push(delta);
    this.traverse(delta);
  }

  /** The person's Back: the browser's button, gesture or swipe. */
  back(): void {
    this.traverse(-1);
  }

  /** Several entries at once: the browser's long-press history menu. */
  jump(delta: number): void {
    this.traverse(delta);
  }

  forward(): void {
    this.traverse(1);
  }

  private traverse(delta: number): void {
    setTimeout(() => {
      const to = this.index + delta;
      if (to < 0) {
        this.left = true;
        return;
      }
      if (to >= this.entries.length || delta === 0) return;
      this.index = to;
      for (const l of [...this.listeners]) l();
    }, 0);
  }

  addEventListener(_type: "popstate", l: () => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_type: "popstate", l: () => void): void {
    this.listeners.delete(l);
  }

  /** Every entry's depth, and where history is. */
  get depths(): number[] {
    return this.entries.map(depthOf);
  }
  get depth(): number {
    return depthOf(this.state);
  }

  /** Every entry holds SvelteKit's keys and at most the marker, from the fixed set. */
  get onlyMarkers(): boolean {
    return this.entries.every((e) => {
      if (typeof e !== "object" || e === null) return false;
      return Object.entries(e).every(([k, v]) => (k === DEPTH_KEY ? [1, 2, 3].includes(v as number) : k in SVELTEKIT_STATE && v === (SVELTEKIT_STATE as Record<string, unknown>)[k]));
    });
  }
}

export function follow(session: Backable, history = new FakeHistory()) {
  const stop = followHistory(session, history, history);
  return { history, stop };
}
