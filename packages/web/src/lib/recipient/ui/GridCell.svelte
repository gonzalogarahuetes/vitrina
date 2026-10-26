<script lang="ts">
  import { en } from "$lib/copy/en";
  import { drawCell } from "$lib/recipient/render";
  import type { Item } from "$lib/recipient/session";

  let {
    item,
    index,
    count,
    watermark,
    onOpen,
    onRetry,
  }: { item: Item; index: number; count: number; watermark: string; onOpen: () => void; onRetry: () => void } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  /* Thumbnails carry the watermark inside the image: it is drawn into the cell's pixels. */
  $effect(() => {
    const c = canvas;
    const thumb = item.thumb;
    const mark = watermark;
    if (c === undefined || thumb.kind !== "ready") return;
    const draw = (): void => {
      const size = c.clientWidth;
      if (size === 0) return;
      // Capped at 2: a hundred cells at 3x is real memory on a phone (brief §11).
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = c.height = Math.round(size * dpr);
      // sRGB, as the JPEGs were encoded (owner/imaging.ts).
      const ctx = c.getContext("2d", { colorSpace: "srgb" });
      try {
        if (ctx !== null) drawCell(ctx, thumb.picture, size, dpr, mark);
      } catch {
        // The picture was closed underneath us (revoked mid-draw): nothing to show.
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  });
</script>

<div class="cell">
  {#if item.thumb.kind === "ready"}
    <button class="open" type="button" onclick={onOpen} aria-label={en["grid.photo.a11y"](index + 1, count)}>
      <canvas bind:this={canvas} aria-hidden="true"></canvas>
    </button>
  {:else if item.thumb.kind === "loading"}
    <div class="loading" role="img" aria-label={en["grid.cell.loading.a11y"](index + 1, count)}></div>
  {:else if item.thumb.kind === "unavailable"}
    <div class="failed unavailable" role="img" aria-label={en["grid.cell.unavailable"]}>
      <span aria-hidden="true">{en["grid.cell.unavailable"]}</span>
    </div>
  {:else}
    <button class="failed" type="button" onclick={onRetry}>
      <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M20 11a8 8 0 1 0-2.3 5.7"></path><path d="M20 4v7h-7"></path></svg
      >
      <span>{en["grid.cell.failed"]}</span>
    </button>
  {/if}
</div>

<style>
  .cell {
    aspect-ratio: 1 / 1;
    position: relative;
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
  }
  .open,
  .failed,
  .loading {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    padding: 0;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }
  .open:focus-visible,
  .failed:focus-visible {
    outline-offset: -3px;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .loading {
    background: var(--surface-sunk);
    animation: pulse 1.8s ease-in-out infinite;
    cursor: default;
  }
  @keyframes pulse {
    0%,
    100% {
      opacity: 0.5;
    }
    50% {
      opacity: 1;
    }
  }
  .unavailable {
    cursor: default;
    border-style: dashed;
  }
  .failed {
    border: 2px solid var(--danger);
    border-radius: 10px;
    background: var(--danger-soft);
    color: var(--danger);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 10px;
    font-size: 16px;
    line-height: 1.3;
  }
</style>
