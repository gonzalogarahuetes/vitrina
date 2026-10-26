<script lang="ts">
  /*
   * One chosen photo in the review: its preview (canvas, never an image
   * element or a URL), its filename (on this screen only), an optional caption
   * and a way to take it out. Nothing here is sent.
   *
   * The caption field has no `maxlength`: that counts UTF-16 units, and the
   * limit is 280 code points (caption.ts). The count appears near the limit.
   */
  import { en } from "$lib/copy/en";
  import { CAPTION_COUNT_FROM, captionLength, checkCaption } from "$lib/owner/caption";
  import type { ReviewRow } from "$lib/owner/album";
  import { drawCell } from "$lib/recipient/render";

  let { row, onCaption, onUnpick }: { row: ReviewRow; onCaption: (caption: string) => void; onUnpick: () => void } = $props();

  let canvas: HTMLCanvasElement | undefined = $state();

  $effect(() => {
    const c = canvas;
    const preview = row.preview;
    if (c === undefined || preview.kind !== "ready") return;
    const size = c.clientWidth || 96;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = c.height = Math.round(size * dpr);
    const ctx = c.getContext("2d", { colorSpace: "srgb" });
    try {
      // The owner's own photo, before it is anyone else's: no watermark.
      if (ctx !== null) drawCell(ctx, preview.picture, size, dpr, "");
    } catch {
      // Closed underneath us (taken out, or sent): nothing to draw.
    }
  });

  const id = $derived(`caption-${row.key}`);
  const check = $derived(checkCaption(row.caption));
  const count = $derived(captionLength(row.caption));
  const showCount = $derived(count >= CAPTION_COUNT_FROM || check === "too-long");
  const describedby = $derived([`${id}-hint`, showCount ? `${id}-count` : "", check !== "ok" ? `${id}-error` : ""].filter((s) => s !== "").join(" "));
</script>

<li class="row" data-pick={row.key} data-read={row.read} data-preview={row.preview.kind}>
  <div class="top">
    {#if row.preview.kind === "ready"}
      <div class="thumb" role="img" aria-label={en["upload.review.preview.a11y"](row.name)}><canvas bind:this={canvas} aria-hidden="true"></canvas></div>
    {:else if row.preview.kind === "loading" || row.read === "reading"}
      <div class="thumb blank" role="img" aria-label={en["upload.review.preview.loading.a11y"](row.name)}></div>
    {:else if row.read === "unreadable"}
      <div class="thumb blank failed" aria-hidden="true"></div>
    {:else}
      <div class="thumb blank failed"><span>{en["upload.review.preview.failed"]}</span></div>
    {/if}
    <div class="side">
      <span class="name">{row.name}</span>
      <button class="btn ghost small" type="button" aria-label={en["upload.review.remove.a11y"](row.name)} onclick={onUnpick}>{en["upload.review.remove"]}</button>
    </div>
  </div>

  {#if row.read === "unreadable"}
    <p class="alert" role="alert">{en["upload.review.unreadable"]}</p>
  {:else}
  <label for={id}>{en["upload.review.caption.label"]}</label>
  <textarea
    {id}
    class="field"
    class:invalid={check !== "ok"}
    rows="2"
    autocomplete="off"
    aria-invalid={check !== "ok"}
    aria-describedby={describedby}
    value={row.caption}
    oninput={(e) => onCaption(e.currentTarget.value)}
  ></textarea>
  <p class="note" id={`${id}-hint`}>{en["upload.review.caption.hint"]}</p>
  {#if showCount}
    <p class="note count" id={`${id}-count`} aria-live="polite">{en["upload.review.caption.count"](count)}</p>
  {/if}
  {#if check === "too-long"}
    <p class="alert" id={`${id}-error`}>{en["upload.review.caption.too-long"]}</p>
  {:else if check === "invalid"}
    <p class="alert" id={`${id}-error`}>{en["upload.review.caption.invalid"]}</p>
  {/if}
  {/if}
</li>

<style>
  .row {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 16px 0;
    border-bottom: 2px solid var(--surface);
  }
  .top {
    display: flex;
    gap: 14px;
    align-items: flex-start;
  }
  .thumb {
    width: 96px;
    height: 96px;
    flex: none;
    border-radius: 10px;
    overflow: hidden;
  }
  .thumb canvas {
    display: block;
    width: 100%;
    height: 100%;
  }
  .blank {
    background: var(--surface);
  }
  .failed {
    display: flex;
    align-items: center;
    padding: 6px;
    font-size: 14px;
    line-height: 1.2;
    color: var(--ink-muted);
  }
  .side {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    min-width: 0;
  }
  .name {
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  .btn.small {
    min-height: 48px;
    font-size: 17px;
    padding: 6px 10px;
  }
  label {
    font-weight: 700;
  }
  textarea {
    resize: vertical;
    font-size: 20px;
    line-height: 1.35;
  }
  .note,
  .alert {
    margin: 0;
    font-size: 17px;
  }
</style>
