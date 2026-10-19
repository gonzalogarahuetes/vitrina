<script lang="ts">
  /*
   * One item of the owner's album, in its true state (flows §3.4, §3.6): the
   * thumbnail drawn to canvas once the server says ready, otherwise what this
   * device is doing with it or what the server last said. No item is drawn as
   * done before `ready`.
   */
  import { en, stuckFor, stuckSince } from "$lib/copy/en";
  import type { MediaItem } from "$lib/owner/album";
  import { drawCell } from "$lib/recipient/render";

  let {
    item,
    index,
    count,
    now,
    onOpen,
    onRetryThumb,
    onResend,
    onDismiss,
    onRemove,
  }: {
    item: MediaItem;
    /** Its position among the photos that can be opened, or -1. */
    index: number;
    count: number;
    now: Date;
    onOpen: () => void;
    onRetryThumb: () => void;
    onResend: () => void;
    onDismiss: () => void;
    onRemove: () => void;
  } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    const c = canvas;
    const thumb = item.thumb;
    if (c === undefined || thumb.kind !== "ready") return;
    const draw = (): void => {
      const size = c.clientWidth;
      if (size === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = c.height = Math.round(size * dpr);
      // sRGB, as the JPEGs were encoded (imaging.ts).
      const ctx = c.getContext("2d", { colorSpace: "srgb" });
      try {
        // The owner's own view: no recipient, so no watermark lines.
        if (ctx !== null) drawCell(ctx, thumb.picture, size, dpr, []);
      } catch {
        // Closed underneath us on the way out.
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(c);
    return () => ro.disconnect();
  });

  const localText = $derived(
    item.local === "queued"
      ? en["upload.queued"]
      : item.local === "preparing"
        ? en["upload.preparing"]
        : item.local === "encrypting"
          ? en["upload.encrypting"]
          : item.local === "uploading"
            ? en["upload.uploading"]
            : item.local === "waiting"
              ? en["upload.waiting"]
              : null,
  );

  const failureText = $derived(
    item.localFailure === null
      ? null
      : item.localFailure === "not-stripped"
        ? en["upload.not-stripped"]
        : item.localFailure === "refused"
          ? en["upload.refused"]
          : en["upload.not-prepared"],
  );

  const stalledText = $derived.by(() => {
    if (!item.stalled || item.updatedAt === null) return null;
    const since = new Date(item.updatedAt);
    return en["upload.stalled"](stuckFor(now.getTime() - since.getTime()), stuckSince(since, now));
  });

  const ready = $derived(item.status === "ready" && item.local === null);
  const removable = $derived(item.id !== null && item.status !== null && item.local === null);
</script>

<li class="cell" data-media={item.id ?? ""} data-state={item.local ?? item.localFailure ?? (item.stalled ? "stalled" : (item.status ?? ""))}>
  <div class="frame">
    {#if ready && item.thumb.kind === "ready"}
      <button class="open" type="button" onclick={onOpen} aria-label={en["album.photo.a11y"](index + 1, count)}>
        <canvas bind:this={canvas} aria-hidden="true"></canvas>
      </button>
    {:else if ready && item.thumb.kind === "loading"}
      <div class="loading" role="img" aria-label={en["grid.cell.loading.a11y"](index + 1, count)}></div>
    {:else if ready && item.thumb.kind === "failed"}
      <button class="state failed" type="button" onclick={onRetryThumb}>{en["grid.cell.failed"]}</button>
    {:else if ready}
      <div class="state" role="img" aria-label={en["grid.cell.unavailable"]}><span aria-hidden="true">{en["grid.cell.unavailable"]}</span></div>
    {:else if failureText !== null}
      <div class="state failed" role="alert">
        {#if item.name !== null}<span class="name">{item.name}</span>{/if}
        <span>{failureText}</span>
      </div>
    {:else if localText !== null}
      <div class="state busy" role="status">
        {#if item.name !== null}<span class="name">{item.name}</span>{/if}
        <span>{localText}</span>
      </div>
    {:else if item.status === "failed"}
      <div class="state failed" role="alert"><span>{item.resendable ? en["upload.failed"] : en["upload.failed.gone"]}</span></div>
    {:else if stalledText !== null}
      <div class="state failed" role="alert"><span>{stalledText}</span></div>
    {:else}
      <div class="state busy" role="status"><span>{item.status === "processing" ? en["media.processing"] : en["media.pending"]}</span></div>
    {/if}
  </div>

  <div class="actions">
    {#if item.localFailure !== null}
      <button class="btn ghost small" type="button" onclick={onDismiss}>{en["upload.dismiss"]}</button>
    {:else}
      {#if item.resendable && item.local === null}
        <button class="btn small" type="button" onclick={onResend}>{en["upload.resend"]}</button>
      {/if}
      {#if removable}
        <button class="btn ghost small" type="button" onclick={onRemove}>{en["media.remove"]}</button>
      {/if}
    {/if}
  </div>
</li>

<style>
  .cell {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }
  .frame {
    aspect-ratio: 1 / 1;
    position: relative;
    border-radius: 10px;
    overflow: hidden;
    background: var(--surface);
  }
  .open,
  .state,
  .loading {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border: 0;
    padding: 0;
    margin: 0;
    background: transparent;
  }
  .open {
    cursor: pointer;
  }
  .open:focus-visible {
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
  .state {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 6px;
    padding: 10px;
    font-size: 16px;
    line-height: 1.3;
    overflow-wrap: anywhere;
    border-radius: 10px;
  }
  .state.busy {
    background: var(--accent-soft);
    border: 2px dashed var(--accent);
  }
  .state.failed {
    background: var(--danger-soft);
    border: 2px solid var(--danger);
    color: var(--danger);
  }
  button.state.failed {
    cursor: pointer;
  }
  .name {
    font-weight: 700;
    color: var(--ink);
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .btn.small {
    min-height: 48px;
    width: 100%;
    font-size: 17px;
    padding: 6px 10px;
  }
</style>
