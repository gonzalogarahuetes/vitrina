import { describe, expect, it } from "vitest";
import { DOUBLE_TAP_MS, Gestures, TAP_MAX_MS } from "./gestures";
import { FIT, MAX_SCALE, canPan, photoRect, type Dims, type View } from "./render";

const PIC: Dims = { width: 1600, height: 1200 };
const STAGE = { w: 390, h: 520 };

/** A viewer's worth of state: the view the gestures read and write. */
function rig(opts: { shown?: boolean } = {}) {
  let view: View = FIT;
  const applied: View[] = [];
  const shown = { value: opts.shown ?? true };
  const g = new Gestures(
    () => (shown.value ? { pic: PIC, stage: STAGE, view } : null),
    (v) => {
      view = v;
      applied.push(v);
    },
  );
  return { g, applied, shown, view: () => view, set: (v: View) => (view = v) };
}

describe("touch gestures (Pointer Events), beside the buttons", () => {
  it("pinch out zooms in about the fingers' midpoint, which keeps the photo's point under it", () => {
    const r = rig();
    const m = { x: 250, y: 260 };
    const before = photoRect(PIC, STAGE, FIT);
    const fx = (m.x - before.x) / before.w;
    r.g.down(1, { x: m.x - 40, y: m.y }, 0);
    r.g.down(2, { x: m.x + 40, y: m.y }, 5);
    r.g.move(1, { x: m.x - 100, y: m.y });
    r.g.move(2, { x: m.x + 100, y: m.y });
    expect(r.view().scale).toBeCloseTo(2.5);
    const after = photoRect(PIC, STAGE, r.view());
    expect(after.x + fx * after.w).toBeCloseTo(m.x);
  });

  it("a pinch stops at the maximum and at fitted, however far the fingers go", () => {
    const r = rig();
    r.g.down(1, { x: 190, y: 260 }, 0);
    r.g.down(2, { x: 200, y: 260 }, 0);
    r.g.move(2, { x: 2000, y: 260 });
    expect(r.view().scale).toBe(MAX_SCALE);
    r.g.move(2, { x: 190.5, y: 260 });
    expect(r.view()).toEqual(FIT);
  });

  it("dragging pans a zoomed photo and stops at its edges, as the buttons do", () => {
    const r = rig();
    r.set({ scale: 3, x: 0, y: 0 });
    r.g.down(7, { x: 100, y: 100 }, 0);
    r.g.move(7, { x: 5000, y: 5000 });
    const v = r.view();
    expect(canPan(PIC, STAGE, v).left).toBe(false);
    expect(canPan(PIC, STAGE, v).up).toBe(false);
    const rect = photoRect(PIC, STAGE, v);
    expect(rect.x).toBeCloseTo(0);
    expect(rect.y).toBeCloseTo(0);
    r.g.move(7, { x: -5000, y: -5000 });
    const end = photoRect(PIC, STAGE, r.view());
    expect(end.x + end.w).toBeCloseTo(STAGE.w);
    expect(end.y + end.h).toBeCloseTo(STAGE.h);
  });

  it("dragging a fitted photo does nothing", () => {
    const r = rig();
    r.g.down(1, { x: 100, y: 100 }, 0);
    r.g.move(1, { x: 300, y: 400 });
    expect(r.view()).toEqual(FIT);
  });

  it("a double tap zooms in from fitted, and a second double tap returns to fitted", () => {
    const r = rig();
    const tap = (t: number) => {
      r.g.down(1, { x: 120, y: 200 }, t);
      r.g.up(1, { x: 121, y: 200 }, t + 40);
    };
    tap(0);
    expect(r.view()).toEqual(FIT);
    tap(150);
    expect(r.view().scale).toBe(2);
    tap(1000);
    tap(1150);
    expect(r.view()).toEqual(FIT);
  });

  it("two taps too far apart in time, a long press, or a moved press, are not a double tap", () => {
    const r = rig();
    r.g.down(1, { x: 120, y: 200 }, 0);
    r.g.up(1, { x: 120, y: 200 }, 40);
    r.g.down(1, { x: 120, y: 200 }, 40 + DOUBLE_TAP_MS + 50);
    r.g.up(1, { x: 120, y: 200 }, 40 + DOUBLE_TAP_MS + 90);
    expect(r.view()).toEqual(FIT);

    const s = rig();
    s.g.down(1, { x: 120, y: 200 }, 0);
    s.g.up(1, { x: 120, y: 200 }, 40);
    s.g.down(1, { x: 120, y: 200 }, 100);
    s.g.up(1, { x: 120, y: 200 }, 100 + TAP_MAX_MS + 1);
    expect(s.view()).toEqual(FIT);

    const m = rig();
    m.g.down(1, { x: 120, y: 200 }, 0);
    m.g.up(1, { x: 120, y: 200 }, 40);
    m.g.down(1, { x: 120, y: 200 }, 100);
    m.g.move(1, { x: 160, y: 200 });
    m.g.up(1, { x: 120, y: 200 }, 140);
    expect(m.view()).toEqual(FIT);
  });

  it("the second finger of a pinch is never a tap", () => {
    const r = rig();
    r.g.down(1, { x: 100, y: 200 }, 0);
    r.g.up(1, { x: 100, y: 200 }, 30);
    r.g.down(1, { x: 100, y: 200 }, 100);
    r.g.down(2, { x: 140, y: 200 }, 110);
    // The first finger lifts first: still part of a pinch, not a second tap.
    r.g.up(1, { x: 100, y: 200 }, 130);
    r.g.up(2, { x: 140, y: 200 }, 140);
    expect(r.view()).toEqual(FIT);
  });

  it("lifting one finger of a pinch carries on as a drag from where the pinch left the photo, with no jump", () => {
    const r = rig();
    r.g.down(1, { x: 150, y: 260 }, 0);
    r.g.down(2, { x: 250, y: 260 }, 0);
    r.g.move(2, { x: 350, y: 260 });
    const pinched = r.view();
    r.g.up(2, { x: 350, y: 260 }, 300);
    r.g.move(1, { x: 150, y: 260 });
    expect(r.view()).toEqual(pinched);
    r.g.move(1, { x: 120, y: 260 });
    expect(r.view().x).toBeCloseTo(pinched.x - 30);
  });

  it("pointercancel ends a gesture, and nothing moves while the photo is not shown", () => {
    const r = rig();
    r.g.down(1, { x: 100, y: 100 }, 0);
    r.g.cancel(1);
    r.g.move(1, { x: 300, y: 300 });
    expect(r.applied).toEqual([]);
    const off = rig({ shown: false });
    off.g.down(1, { x: 100, y: 100 }, 0);
    off.g.move(1, { x: 300, y: 300 });
    off.g.up(1, { x: 300, y: 300 }, 10);
    expect(off.g.active).toBe(0);
    expect(off.applied).toEqual([]);
  });
});
