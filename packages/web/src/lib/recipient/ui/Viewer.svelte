<script lang="ts">
  import { en } from "$lib/copy/en";
  import { FIT, ZOOM_LEVELS, canPan, drawViewer, panBy, zoomBy, type Direction, type Picture, type Size, type View } from "$lib/recipient/render";
  import type { Viewer } from "$lib/recipient/session";

  let {
    viewer,
    standIn,
    count,
    watermark,
    onClose,
  }: { viewer: Viewer; standIn: Picture | null; count: number; watermark: readonly string[]; onClose: () => void } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();
  let back: HTMLButtonElement | undefined = $state();
  let stage = $state<Size>({ w: 0, h: 0 });
  let view = $state<View>(FIT);

  const shown = $derived(viewer.phase === "shown" && viewer.picture !== null);
  const hasStage = $derived(viewer.phase === "loading" || viewer.phase === "shown");
  const picture = $derived(viewer.picture ?? (viewer.phase === "loading" ? standIn : null));
  const pans = $derived(shown && viewer.picture !== null ? canPan(viewer.picture, stage, view) : { up: false, down: false, left: false, right: false });

  // A new photo starts fitted.
  $effect(() => {
    void viewer.picture;
    view = FIT;
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

  // Photo first, watermark last, in the same pixels (brief §5).
  $effect(() => {
    const c = canvas;
    const pic = picture;
    const s = stage;
    const v = view;
    const lines = watermark;
    const blur = viewer.phase === "loading";
    if (c === undefined || pic === null || s.w === 0 || s.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(s.w * dpr);
    c.height = Math.round(s.h * dpr);
    const ctx = c.getContext("2d");
    try {
      if (ctx !== null) drawViewer(ctx, pic, s, dpr, blur ? FIT : v, lines, blur);
    } catch {
      // Closed underneath us on the way out: nothing to draw.
    }
  });

  function zoom(delta: number): void {
    if (viewer.picture !== null) view = zoomBy(viewer.picture, stage, view, delta);
  }

  function pan(dir: Direction): void {
    if (viewer.picture !== null) view = panBy(viewer.picture, stage, view, dir);
  }
</script>

<main class="viewer">
  <div class="top">
    <button class="btn ghost" type="button" bind:this={back} onclick={onClose}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M15 5l-7 7 7 7"></path></svg
      >
      <span>{en["viewer.back"]}</span>
    </button>
  </div>

  {#if hasStage}
    <div class="stage">
      <div class="frame" role="img" aria-label={en["viewer.photo.a11y"](viewer.index + 1, count)}>
        <canvas bind:this={canvas} aria-hidden="true"></canvas>
      </div>
      {#if viewer.phase === "loading"}
        <div class="loading" role="status"><span>{en["viewer.loading"]}</span></div>
      {/if}
    </div>

    <div class="controls">
      <div class="zoom">
        <button class="ctl" type="button" onclick={() => zoom(-1)} disabled={!shown || view.zoom <= 0}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"
            ><circle cx="11" cy="11" r="7"></circle><path d="M8 11h6"></path><path d="M20 20l-4-4"></path></svg
          >
          <span>{en["viewer.zoom-out"]}</span>
        </button>
        <button class="ctl" type="button" onclick={() => zoom(1)} disabled={!shown || view.zoom >= ZOOM_LEVELS.length - 1}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"
            ><circle cx="11" cy="11" r="7"></circle><path d="M8 11h6M11 8v6"></path><path d="M20 20l-4-4"></path></svg
          >
          <span>{en["viewer.zoom-in"]}</span>
        </button>
      </div>
      <div class="pad">
        <span></span>
        <button class="ctl" type="button" aria-label={en["viewer.pan-up"]} onclick={() => pan("up")} disabled={!pans.up}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 15l7-7 7 7"></path></svg>
        </button>
        <span></span>
        <button class="ctl" type="button" aria-label={en["viewer.pan-left"]} onclick={() => pan("left")} disabled={!pans.left}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>
        </button>
        <button class="ctl" type="button" onclick={() => (view = FIT)} disabled={!shown || view.zoom === 0}>{en["viewer.fit"]}</button>
        <button class="ctl" type="button" aria-label={en["viewer.pan-right"]} onclick={() => pan("right")} disabled={!pans.right}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7"></path></svg>
        </button>
        <span></span>
        <button class="ctl" type="button" aria-label={en["viewer.pan-down"]} onclick={() => pan("down")} disabled={!pans.down}>
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 9l7 7 7-7"></path></svg>
        </button>
        <span></span>
      </div>
    </div>
  {:else}
    <div class="gone" role="alert" class:failed={viewer.phase === "failed"}>
      <h1>{viewer.phase === "removed" ? en["viewer.removed"] : en["viewer.failed"]}</h1>
      <div class="bottom">
        <button class="btn" type="button" onclick={onClose}>{en["viewer.back-to-album"]}</button>
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
  }
  .top {
    padding: 8px 12px;
    display: flex;
    align-items: center;
    min-height: 76px;
  }
  .stage {
    flex: 1;
    min-height: 0;
    position: relative;
    background: var(--stage);
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
  }
  .frame {
    position: absolute;
    inset: 0;
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
  .controls {
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-width: 640px;
    width: 100%;
    margin: 0 auto;
  }
  .zoom {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .pad {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }
  .ctl {
    min-height: var(--target);
    border-radius: var(--radius);
    border: 2px solid var(--accent);
    background: #fff;
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    cursor: pointer;
    padding: 6px;
    font-weight: 700;
  }
  .ctl:disabled {
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
