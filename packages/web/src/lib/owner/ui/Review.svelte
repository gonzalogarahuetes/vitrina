<script lang="ts">
  /*
   * The review, between choosing photos and sending them (flows §3.6, before
   * step 1): previews, a caption per photo, and the last chance to take a
   * wrong photo out. Nothing is prepared, encrypted or sent before "Send".
   * Over the album, which is inert while this is open.
   */
  import { copy } from "$lib/copy/language.svelte";
  import { checkCaption } from "$lib/owner/caption";
  import { OwnerAlbum, type ReviewRow as Row } from "$lib/owner/album";
  import ReviewRow from "./ReviewRow.svelte";

  const t = $derived(copy());

  let {
    rows,
    onCaption,
    onUnpick,
    onCancel,
    onSend,
  }: {
    rows: readonly Row[];
    onCaption: (key: string, caption: string) => void;
    onUnpick: (key: string) => void;
    onCancel: () => void;
    onSend: () => void;
  } = $props();

  let heading: HTMLHeadingElement | undefined = $state();
  $effect(() => {
    heading?.focus();
  });

  // Only photos whose bytes were read are sent; an unreadable one stays behind with its message.
  const toSend = $derived(OwnerAlbum.sendable(rows));
  const sendable = $derived(toSend.length > 0 && rows.every((r) => r.read !== "reading") && toSend.every((r) => checkCaption(r.caption) === "ok"));
</script>

<div class="review" role="dialog" aria-modal="true" aria-labelledby="review-title">
  <div class="inner">
    <h2 id="review-title" tabindex="-1" bind:this={heading}>{t["upload.review.title"](rows.length)}</h2>
    <p class="note">{t["upload.review.intro"]}</p>
    <ul class="rows">
      {#each rows as row (row.key)}
        <ReviewRow {row} onCaption={(c) => onCaption(row.key, c)} onUnpick={() => onUnpick(row.key)} />
      {/each}
    </ul>
    <div class="actions">
      <button class="btn" type="button" disabled={!sendable} onclick={onSend}>{t["upload.review.send"](toSend.length)}</button>
      <button class="btn ghost" type="button" onclick={onCancel}>{t["upload.review.cancel"]}</button>
    </div>
  </div>
</div>

<style>
  .review {
    position: fixed;
    inset: 0;
    z-index: 2;
    background: var(--paper);
    overflow-y: auto;
  }
  .inner {
    max-width: 640px;
    margin: 0 auto;
    padding: 28px var(--gutter) var(--gutter);
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  h2 {
    margin: 0;
    font-size: 28px;
    line-height: 1.2;
  }
  h2:focus {
    outline: none;
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding-top: 8px;
  }
  .actions .btn.ghost {
    width: 100%;
  }
</style>
