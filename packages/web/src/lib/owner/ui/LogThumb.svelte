<script lang="ts">
  /* A log entry's photo: the owner's own thumbnail, drawn to canvas as the album draws it, or the removed state. */
  import { en } from "$lib/copy/en";
  import type { LogPhoto } from "$lib/owner/people";
  import { drawCell } from "$lib/recipient/render";

  let { photo }: { photo: LogPhoto } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    const c = canvas;
    if (c === undefined || photo.kind !== "photo" || photo.thumb.kind !== "ready") return;
    const picture = photo.thumb.picture;
    const size = c.clientWidth || 72;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = Math.round(size * dpr);
    const ctx = c.getContext("2d", { colorSpace: "srgb" });
    try {
      // The owner's own view: no watermark.
      if (ctx !== null) drawCell(ctx, picture, size, dpr, "");
    } catch {
      // Closed underneath us on the way out.
    }
  });
</script>

{#if photo.kind === "removed"}
  <p class="removed">{en["log.photo.removed"]}</p>
{:else if photo.thumb.kind === "ready"}
  <div class="thumb" role="img" aria-label={en["log.photo.a11y"]}><canvas class="thumb" bind:this={canvas} aria-hidden="true"></canvas></div>
{:else if photo.thumb.kind === "loading"}
  <div class="thumb blank" role="img" aria-label={en["log.photo.loading.a11y"]}></div>
{:else if photo.thumb.kind === "failed" || photo.thumb.kind === "unavailable"}
  <p class="removed">{en["log.photo.failed"]}</p>
{/if}

<style>
  .thumb {
    display: block;
    width: 72px;
    height: 72px;
    flex: none;
    border-radius: 8px;
  }
  .blank {
    background: var(--surface);
  }
  .removed {
    margin: 0;
    color: var(--ink-muted);
    font-size: 17px;
  }
</style>
