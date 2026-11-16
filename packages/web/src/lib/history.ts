/*
 * The browser's Back follows the app's screens. Each path is one page whose
 * screens are session states, so without this the whole app is one history
 * entry and Back leaves it from anywhere.
 *
 * The session is the authority. It says how deep its screen sits (`depth`: 0
 * is the top, which Back leaves) and what Back does there (`back()`, which
 * calls the same method as the screen's own back or cancel control, guards
 * included). This module only keeps history matching that depth:
 *
 *   - deeper: push one entry per level;
 *   - shallower: go back to the entry at that depth;
 *   - a popstate to a shallower entry is Back: the session is asked, once per
 *     level, and if it stays (it asked first, or refused), the entries are
 *     pushed again, so the next Back asks again;
 *   - a popstate to a deeper entry (Forward, or an entry left over from
 *     before a reload) reopens nothing: history goes back to the session's
 *     depth.
 *
 * The native History API, not SvelteKit's shallow routing: its pushState
 * writes page.url into history.state and gives each entry an index of its
 * own, which its router then acts on. Here every pushed entry is a copy of
 * the current one, SvelteKit's indices included, so its popstate handler sees
 * the index it is already on and does nothing; and the copy adds one key,
 * DEPTH_KEY, holding 1, 2 or 3, and nothing else. No URL is ever passed, so
 * the address never changes. (`vite dev` logs SvelteKit's one-time warning
 * about the native calls; that warning is expected.)
 */

export const DEPTH_KEY = "vitrina:depth";
/** The deepest any screen sits: the owner's album → people → access log. */
export const MAX_DEPTH = 3;

export type HistoryLike = {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  go(delta: number): void;
};

export type PopstateTarget = {
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
};

export type Backable = {
  /** 0 is the top: the owner's album list, the recipient's grid, and every screen that adds no entry. */
  readonly depth: number;
  /** What the screen's own back or cancel control does. It may ask first, or refuse. */
  back(): void;
  subscribe(listener: () => void): () => void;
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The depth an entry was pushed at. Anything but 1…MAX_DEPTH, including no marker, is the top. */
export function depthOf(state: unknown): number {
  const d = isRecord(state) ? state[DEPTH_KEY] : undefined;
  return typeof d === "number" && Number.isInteger(d) && d >= 1 && d <= MAX_DEPTH ? d : 0;
}

/** The current entry's state with the marker for `depth`: everything else (SvelteKit's) kept as it is. */
function marked(state: unknown, depth: number): Record<string, unknown> {
  const rest: Record<string, unknown> = isRecord(state) ? { ...state } : {};
  delete rest[DEPTH_KEY];
  return { ...rest, [DEPTH_KEY]: depth };
}

/** Keeps `history` at `session`'s depth until the returned function is called. */
export function followHistory(session: Backable, history: HistoryLike, target: PopstateTarget): () => void {
  /** The depth of the entry history is on, or will be on once a pending go() lands. */
  let at = depthOf(history.state);
  /** A go() of ours has not landed yet: its popstate is ours, not the person's. */
  let traversing = false;
  /** Asking the session to go back: hold reconciling until it has answered. */
  let asking = false;

  const reconcile = (): void => {
    if (traversing || asking) return;
    const want = Math.min(Math.max(session.depth, 0), MAX_DEPTH);
    if (want > at) {
      for (let d = at + 1; d <= want; d++) history.pushState(marked(history.state, d), "");
      at = want;
    } else if (want < at) {
      traversing = true;
      history.go(want - at);
    }
  };

  const onPopstate = (): void => {
    const now = depthOf(history.state);
    if (traversing) {
      traversing = false;
      at = now;
      return reconcile();
    }
    const from = at;
    at = now;
    // Back, by one level or (from the browser's history menu) several: one ask per level, stopping when one does not go back.
    asking = true;
    try {
      for (let i = 0; i < from - now; i++) {
        const before = session.depth;
        session.back();
        if (session.depth >= before) break;
      }
    } finally {
      asking = false;
    }
    reconcile();
  };

  target.addEventListener("popstate", onPopstate);
  const unsubscribe = session.subscribe(reconcile);
  return () => {
    target.removeEventListener("popstate", onPopstate);
    unsubscribe();
  };
}
