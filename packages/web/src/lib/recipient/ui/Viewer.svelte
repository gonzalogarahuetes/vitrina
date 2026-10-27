<script lang="ts">
  /*
   * Flows §4.5, for recipient and owner alike: the photo on canvas with the
   * watermark in its pixels, the explicit zoom and pan buttons (brief §11: a
   * requirement, and they stay), touch gestures beside them (gestures.ts), and
   * the owner's caption as plain text below the photo, never drawn over it.
   *
   * The buttons take one row below the photo (Zoom out · Fit · Zoom in); the
   * pan arrows sit on the photo's edges, only while it can pan (panArrows),
   * and the watermark is drawn clear of them. Every control is a real button,
   * labelled, in visual order; an unavailable one is aria-disabled rather than
   * disabled, so pressing it to its limit never drops keyboard focus.
   *
   * `touch-action: none` is on the photo's frame only. The page's own zoom is
   * never disabled: people with poor eyesight need it for everything else.
   */
  import { copy } from "$lib/copy/language.svelte";
  import { Gestures } from "$lib/recipient/gestures";
  import { FIT, canPan, canZoom, drawViewer, panArrows, panBy, zoomBy, type Direction, type Picture, type Size, type View } from "$lib/recipient/render";
  import type { Viewer } from "$lib/recipient/session";
  import LanguageSwitch from "$lib/ui/LanguageSwitch.svelte";

  const t = $derived(copy());

  let {
    viewer,
    standIn,
    count,
    watermark,
    caption,
    onClose,
  }: {
    viewer: Viewer;
    standIn: Picture | null;
    count: number;
    /** One line, drawn into the pixels; empty for the owner's own view. */
    watermark: string;
    /** The owner's caption for this photo, from its metadata envelope. */
    caption: string | null;
    onClose: () => void;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let frame: HTMLDivElement | undefined = $state();
  let back: HTMLButtonElement | undefined = $state();
  let stage = $state<Size>({ w: 0, h: 0 });
  let view = $state<View>(FIT);

  const shown = $derived(viewer.phase === "shown" && viewer.picture !== null);
  const hasStage = $derived(viewer.phase === "loading" || viewer.phase === "shown");
  const picture = $derived(viewer.picture ?? (viewer.phase === "loading" ? standIn : null));
  const pans = $derived(shown && viewer.picture !== null ? canPan(viewer.picture, stage, view) : { up: false, down: false, left: false, right: false });
  const zooms = $derived(shown ? canZoom(view) : { in: false, out: false });
  const arrows = $derived(shown && viewer.picture !== null ? panArrows(viewer.picture, stage, view) : {});

  const gestures = new Gestures(
    () => (viewer.phase === "shown" && viewer.picture !== null && stage.w > 0 ? { pic: viewer.picture, stage, view } : null),
    (v) => (view = v),
  );

  // A new photo starts fitted, with no gesture carried over.
  $effect(() => {
    void viewer.picture;
    gestures.reset();
    view = FIT;
  });

  // Pointer Events on the photo's frame. Positions are in the stage's CSS pixels.
  $effect(() => {
    const f = frame;
    if (f === undefined) return;
    const at = (e: PointerEvent) => {
      const r = f.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent): void => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      gestures.down(e.pointerId, at(e), e.timeStamp);
      try {
        f.setPointerCapture(e.pointerId);
      } catch {
        // Not an active pointer (a synthetic event): moves still arrive while it stays over the frame.
      }
    };
    const move = (e: PointerEvent): void => gestures.move(e.pointerId, at(e));
    const up = (e: PointerEvent): void => gestures.up(e.pointerId, at(e), e.timeStamp);
    const cancel = (e: PointerEvent): void => gestures.cancel(e.pointerId);
    f.addEventListener("pointerdown", down);
    f.addEventListener("pointermove", move);
    f.addEventListener("pointerup", up);
    f.addEventListener("pointercancel", cancel);
    return () => {
      f.removeEventListener("pointerdown", down);
      f.removeEventListener("pointermove", move);
      f.removeEventListener("pointerup", up);
      f.removeEventListener("pointercancel", cancel);
      gestures.reset();
    };
  });

  $effect(() => {
    back?.focus();
  });

  // Track the stage's CSS size; the backing store follows it.
  $effect(() => {
    const c = canvas;
    if (c === undefined) return;
    const measure = (): void => {
      stage = { w: c.clientWidth, h: c.clientHeight };
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(c);
    return () => ro.disconnect();
  });

  // Photo first, watermark last, in the same pixels (brief §5). Redrawn from the
  // decoded bitmap on every change of view, so each zoom level is drawn at its
  // own scale rather than by stretching an earlier frame.
  $effect(() => {
    const c = canvas;
    const pic = picture;
    const s = stage;
    const v = view;
    const mark = watermark;
    const blur = viewer.phase === "loading";
    if (c === undefined || pic === null || s.w === 0 || s.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(s.w * dpr);
    const h = Math.round(s.h * dpr);
    // Resizing reallocates the backing store: only when the stage changed, not on every gesture frame.
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    // sRGB, as the JPEGs were encoded (owner/imaging.ts).
    const ctx = c.getContext("2d", { colorSpace: "srgb" });
    try {
      if (ctx !== null) drawViewer(ctx, pic, s, dpr, blur ? FIT : v, mark, blur);
    } catch {
      // Closed underneath us on the way out: nothing to draw.
    }
  });

  function zoom(dir: 1 | -1): void {
    if (viewer.picture !== null && (dir > 0 ? zooms.in : zooms.out)) view = zoomBy(viewer.picture, stage, view, dir);
  }

  function pan(dir: Direction): void {
    if (viewer.picture !== null && pans[dir]) view = panBy(viewer.picture, stage, view, dir);
  }

  function fit(): void {
    if (zooms.out) view = FIT;
  }

  const ARROWS: readonly { dir: Direction; label: string; path: string }[] = $derived([
    { dir: "up", label: t["viewer.pan-up"], path: "M5 15l7-7 7 7" },
    { dir: "left", label: t["viewer.pan-left"], path: "M15 5l-7 7 7 7" },
    { dir: "right", label: t["viewer.pan-right"], path: "M9 5l7 7-7 7" },
    { dir: "down", label: t["viewer.pan-down"], path: "M5 9l7 7 7-7" },
  ]);
</script>

<main class="viewer">
  <div class="top">
    <button class="btn ghost" type="button" bind:this={back} onclick={onClose}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M15 5l-7 7 7 7"></path></svg
      >
      <span>{t["viewer.back"]}</span>
    </button>
    <LanguageSwitch compact />
  </div>

  {#if hasStage}
    <div class="stage">
      <div
        class="frame"
        role="img"
        aria-label={t["viewer.photo.a11y"](viewer.index + 1, count)}
        aria-describedby={caption !== null ? "viewer-caption" : undefined}
        bind:this={frame}
      >
        <canvas bind:this={canvas} aria-hidden="true"></canvas>
      </div>
      <!-- On the photo's edges, only while it can pan; in reading order: up, left, right, down. -->
      {#each ARROWS as a (a.dir)}
        {#if arrows[a.dir] !== undefined}
          <button class="arrow {a.dir}" type="button" aria-label={a.label} aria-disabled={!pans[a.dir]} onclick={() => pan(a.dir)}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={a.path}></path></svg>
          </button>
        {/if}
      {/each}
      {#if viewer.phase === "loading"}
        <div class="loading" role="status"><span>{t["viewer.loading"]}</span></div>
      {/if}
    </div>

    {#if caption !== null}
      <!-- Plain text, below the photo: never drawn into it, never markup. -->
      <p class="caption" id="viewer-caption">{caption}</p>
    {/if}

    <div class="controls">
      <button class="ctl" type="button" aria-disabled={!zooms.out} onclick={() => zoom(-1)}>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"
          ><circle cx="11" cy="11" r="7"></circle><path d="M8 11h6"></path><path d="M20 20l-4-4"></path></svg
        >
        <span>{t["viewer.zoom-out"]}</span>
      </button>
      <button class="ctl" type="button" aria-disabled={!zooms.out} onclick={fit}>{t["viewer.fit"]}</button>
      <button class="ctl" type="button" aria-disabled={!zooms.in} onclick={() => zoom(1)}>
        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"
          ><circle cx="11" cy="11" r="7"></circle><path d="M8 11h6M11 8v6"></path><path d="M20 20l-4-4"></path></svg
        >
        <span>{t["viewer.zoom-in"]}</span>
      </button>
    </div>
  {:else}
    <div class="gone" role="alert" class:failed={viewer.phase === "failed"}>
      <h1>{viewer.phase === "removed" ? t["viewer.removed"] : t["viewer.failed"]}</h1>
      <div class="bottom">
        <button class="btn" type="button" onclick={onClose}>{t["viewer.back-to-album"]}</button>
      </div>
    </div>
  {/if}
</main>

<style>
  .viewer {
    position: fixed;
    inset: 0;
    display: flex;
    flex-direction: column;
    background: var(--paper);
    z-index: 1;
    /* A long caption on a short phone: the photo keeps most of the screen, and the rest scrolls. */
    overflow-y: auto;
  }
  .top {
    padding: 8px 12px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    min-height: 76px;
  }
  .stage {
    flex: 1 0 auto;
    min-height: 45dvh;
    position: relative;
    background: var(--stage);
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .frame {
    position: absolute;
    inset: 0;
    /* The photo only: pinch, drag and double tap here are the viewer's own. Nowhere else. */
    touch-action: none;
  }
  .caption {
    margin: 0;
    padding: 12px 16px 0;
    max-width: 640px;
    width: 100%;
    margin-inline: auto;
    white-space: pre-line;
    overflow-wrap: anywhere;
    font-size: 19px;
    line-height: 1.4;
    color: var(--ink);
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .loading {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: 16px;
    display: flex;
    justify-content: center;
  }
  .loading span {
    background: rgb(28 27 25 / 0.85);
    color: #fff;
    border-radius: 12px;
    padding: 10px 14px;
  }
  /* One row: Zoom out · Fit · Zoom in, at the target size. */
  .controls {
    padding: 12px 16px 16px;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
  }
  /* render.ts ARROW_PX and ARROW_INSET_PX: the watermark is drawn clear of exactly these boxes. */
  .arrow {
    position: absolute;
    width: 60px;
    height: 60px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid rgb(255 255 255 / 0.85);
    background: rgb(28 27 25 / 0.45);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .arrow.up {
    top: 8px;
    left: calc(50% - 30px);
  }
  .arrow.down {
    bottom: 8px;
    left: calc(50% - 30px);
  }
  .arrow.left {
    left: 8px;
    top: calc(50% - 30px);
  }
  .arrow.right {
    right: 8px;
    top: calc(50% - 30px);
  }
  .arrow[aria-disabled="true"] {
    opacity: 0.35;
    cursor: default;
  }
  .arrow:focus-visible {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }
  /* Icon above label, so three fit across a 360 px phone at the full target height. */
  .ctl {
    min-height: var(--target);
    border-radius: var(--radius);
    border: 2px solid var(--accent);
    background: #fff;
    color: var(--accent);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0;
    cursor: pointer;
    padding: 4px;
    font-weight: 700;
    font-size: 17px;
    line-height: 1.15;
    text-align: center;
  }
  .ctl svg {
    width: 26px;
    height: 26px;
  }
  .ctl[aria-disabled="true"] {
    border-color: var(--disabled-line);
    color: var(--disabled-ink);
    background: var(--disabled-fill);
    cursor: default;
  }
  .gone {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 28px;
    padding: 48px var(--gutter) var(--gutter);
  }
  .gone.failed {
    background: var(--surface);
  }
  .gone h1 {
    margin: 0;
    font-size: 28px;
    line-height: 1.2;
  }
</style>
