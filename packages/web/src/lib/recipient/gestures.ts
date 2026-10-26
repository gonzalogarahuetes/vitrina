/*
 * Touch gestures for the viewer, beside its buttons (brief §11: not everyone
 * can pinch, so the buttons stay). Pointer Events, so a finger, a pen and a
 * mouse are one code path: one pointer drags, two pinch (and pan with their
 * midpoint), and a double tap zooms in about the tapped point or returns to
 * fitted. Every result goes through render.ts's moveView, so a gesture stops at
 * the photo's edges exactly as the buttons do.
 *
 * Plain TypeScript with no DOM: Viewer.svelte feeds it each event's pointer id,
 * position on the stage and timestamp, and redraws from the decoded bitmap
 * with whatever view it hands back.
 */
import { doubleTap, moveView, type Dims, type Point, type Size, type View } from "./render";

/** Two taps closer than this in time, and in space, are a double tap. */
export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_SLOP_PX = 30;
/** A press that moves further than this, or lasts longer, is not a tap. */
export const TAP_SLOP_PX = 10;
export const TAP_MAX_MS = 250;

export type Scene = { readonly pic: Dims; readonly stage: Size; readonly view: View };

const dist = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class Gestures {
  private readonly pointers = new Map<number, Point>();
  /** The view and every pointer's position when the current gesture began: re-taken whenever a pointer is added or lifted. */
  private start: { view: View; at: Map<number, Point> } | null = null;
  private press: { id: number; at: Point; t: number; moved: boolean } | null = null;
  private lastTap: { at: Point; t: number } | null = null;

  /**
   * `scene` is null while there is nothing to move (the photo is still
   * loading, or failed): presses are then ignored.
   */
  constructor(
    private readonly scene: () => Scene | null,
    private readonly apply: (view: View) => void,
  ) {}

  get active(): number {
    return this.pointers.size;
  }

  down(id: number, at: Point, t: number): void {
    const s = this.scene();
    if (s === null) return;
    this.pointers.set(id, at);
    this.rebase(s.view);
    if (this.pointers.size === 1) {
      this.press = { id, at, t, moved: false };
    } else {
      // A second finger: a pinch, never a tap.
      this.press = null;
      this.lastTap = null;
    }
  }

  move(id: number, at: Point): void {
    if (!this.pointers.has(id)) return;
    this.pointers.set(id, at);
    if (this.press?.id === id && dist(this.press.at, at) > TAP_SLOP_PX) this.press.moved = true;
    const s = this.scene();
    const start = this.start;
    if (s === null || start === null) return;
    const ids = [...start.at.keys()].filter((k) => this.pointers.has(k));
    const [a, b] = ids;
    if (a === undefined) return;
    const a0 = start.at.get(a) as Point;
    const a1 = this.pointers.get(a) as Point;
    if (b === undefined) {
      this.apply(moveView(s.pic, s.stage, start.view, start.view.scale, a0, a1));
      return;
    }
    const b0 = start.at.get(b) as Point;
    const b1 = this.pointers.get(b) as Point;
    const d0 = dist(a0, b0);
    const scale = d0 > 0 ? (start.view.scale * dist(a1, b1)) / d0 : start.view.scale;
    this.apply(moveView(s.pic, s.stage, start.view, scale, mid(a0, b0), mid(a1, b1)));
  }

  up(id: number, at: Point, t: number): void {
    if (!this.pointers.has(id)) return;
    this.pointers.delete(id);
    const s = this.scene();
    if (s !== null) this.rebase(s.view);
    const press = this.press;
    this.press = null;
    if (s === null || press?.id !== id || press.moved || dist(press.at, at) > TAP_SLOP_PX || t - press.t > TAP_MAX_MS) return;
    const last = this.lastTap;
    if (last !== null && t - last.t <= DOUBLE_TAP_MS && dist(last.at, at) <= DOUBLE_TAP_SLOP_PX) {
      this.lastTap = null;
      this.apply(doubleTap(s.pic, s.stage, s.view, at));
      return;
    }
    this.lastTap = { at, t };
  }

  /** pointercancel: the pointer is gone and was never a tap. */
  cancel(id: number): void {
    if (!this.pointers.delete(id)) return;
    if (this.press?.id === id) this.press = null;
    const s = this.scene();
    if (s !== null) this.rebase(s.view);
  }

  /** The photo changed or the viewer closed: forget everything in progress. */
  reset(): void {
    this.pointers.clear();
    this.start = null;
    this.press = null;
    this.lastTap = null;
  }

  private rebase(view: View): void {
    this.start = this.pointers.size === 0 ? null : { view, at: new Map(this.pointers) };
  }
}
