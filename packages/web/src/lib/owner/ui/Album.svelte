<script lang="ts">
  /*
   * The owner's album (flows §3.4): every item in its real state, upload
   * (§3.6, with its review step: previews and captions before anything is
   * sent), removal with its computed statement (§3.7), and the recipient's
   * viewer for the full photo (§4.5), drawn without a watermark because the
   * owner is not a recipient. From here, the album's invite (§3.8) and its
   * people and access log (§3.9, §3.10).
   */
  import { copy, format } from "$lib/copy/language.svelte";
  import type { AlbumScreen } from "$lib/owner/album";
  import type { Expiry } from "$lib/owner/session";
  import Viewer from "$lib/recipient/ui/Viewer.svelte";
  import MediaCell from "./MediaCell.svelte";
  import Review from "./Review.svelte";

  const t = $derived(copy());
  const fmt = $derived(format());

  let {
    album,
    expiry,
    onBack,
    onLeave,
    onStay,
    onChoose,
    onCaption,
    onUnpick,
    onCancelReview,
    onSendReview,
    onOpen,
    onCloseViewer,
    onRetryThumb,
    onResend,
    onDismiss,
    onRemove,
    onCancelRemove,
    onConfirmRemove,
    onInvite,
    onPeople,
  }: {
    album: AlbumScreen;
    expiry: Expiry | null;
    onBack: () => void;
    onLeave: () => void;
    onStay: () => void;
    /** Opens the review: nothing is prepared or sent until onSendReview. */
    onChoose: (files: File[]) => void;
    onCaption: (key: string, caption: string) => void;
    onUnpick: (key: string) => void;
    onCancelReview: () => void;
    onSendReview: () => void;
    onOpen: (key: string) => void;
    onCloseViewer: () => void;
    onRetryThumb: (key: string) => void;
    onResend: (key: string) => void;
    onDismiss: (key: string) => void;
    onRemove: (key: string) => void;
    onCancelRemove: () => void;
    onConfirmRemove: () => void;
    /** Flows §3.8. */
    onInvite: () => void;
    /** Flows §3.9, §3.10. */
    onPeople: () => void;
  } = $props();

  let input: HTMLInputElement | undefined = $state();
  let now = $state(new Date());

  // "Stuck for …" reads the clock; a minute is fine-grained enough.
  $effect(() => {
    const t = setInterval(() => (now = new Date()), 60_000);
    return () => clearInterval(t);
  });

  const viewable = $derived(
    album.items.filter((i) => i.status === "ready" && i.size !== null),
  );
  const confirmItem = $derived(
    album.confirm === null
      ? undefined
      : album.items.find((i) => i.key === album.confirm?.key),
  );

  function chosen(): void {
    const files =
      input?.files === null || input?.files === undefined
        ? []
        : Array.from(input.files);
    // Cleared at once: the same photo can be chosen again, and the input holds nothing afterwards.
    if (input !== undefined) input.value = "";
    if (files.length > 0) onChoose(files);
  }

  function statement(
    s: NonNullable<AlbumScreen["confirm"]>["statement"],
  ): string {
    if (s === "never-ready") return t["remove.never-ready"];
    if (s === "unopened") return t["remove.unopened"];
    if (s === "opened") return t["remove.opened"];
    return t["remove.checking"];
  }
</script>

<main
  class="screen album"
  inert={album.viewer !== null ||
    album.confirm !== null ||
    album.review !== null ||
    album.leaving}
>
  <div class="top">
    <button class="btn ghost back" type="button" onclick={onBack}>
      <svg
        width="28"
        height="28"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg
      >
      <span>{t["album.back"]}</span>
    </button>
  </div>

  <h1 class:failed-text={album.title === null}>
    {album.title ?? t["albums.failed.title"]}
  </h1>

  {#if expiry?.ending}
    <p class="ending" role="status">
      {t["session.ending"](fmt.sessionEndTime(expiry.endsAt))}
    </p>
  {/if}

  {#if album.phase === "loading"}
    <p class="note" role="status">{t["album.loading"]}</p>
  {:else}
    <div class="sharing">
      <button class="btn" type="button" onclick={onInvite}
        >{t["album.invite"]}</button
      >
      <button class="btn ghost" type="button" onclick={onPeople}
        >{t["album.people"]}</button
      >
    </div>

    <div class="add">
      <label class="btn" for="add-photos">{t["album.add"]}</label>
      <input
        id="add-photos"
        class="visually-hidden"
        type="file"
        accept="image/*"
        multiple
        bind:this={input}
        onchange={chosen}
      />
      {#if album.chooseRefused}
        <p class="alert" role="alert">{t["upload.too-large"]}</p>
      {/if}
      <p class="note">{t["upload.stripped"]}</p>
      <p class="note">{t["upload.downscale"]}</p>
    </div>

    {#if album.erasurePending > 0}
      <p class="pending" role="status">
        {t["remove.pending"](album.erasurePending)}
      </p>
    {/if}

    {#if album.items.length === 0}
      <p class="note">{t["album.empty"]}</p>
    {:else}
      <ul class="cells">
        {#each album.items as item (item.key)}
          <MediaCell
            {item}
            index={viewable.indexOf(item)}
            count={viewable.length}
            {now}
            onOpen={() => onOpen(item.key)}
            onRetryThumb={() => onRetryThumb(item.key)}
            onResend={() => onResend(item.key)}
            onDismiss={() => onDismiss(item.key)}
            onRemove={() => onRemove(item.key)}
          />
        {/each}
      </ul>
    {/if}
  {/if}
</main>

{#if album.confirm !== null}
  <div
    class="sheet"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="remove-title"
    aria-describedby="remove-statement"
  >
    <h2 id="remove-title">{t["remove.title"]}</h2>
    <p id="remove-statement" role="status">
      {statement(album.confirm.statement)}
    </p>
    {#if album.confirm.removing}
      <p class="note" role="status">{t["remove.busy"]}</p>
    {:else}
      <button
        class="btn danger"
        type="button"
        disabled={album.confirm.statement === null || confirmItem === undefined}
        onclick={onConfirmRemove}>{t["remove.confirm"]}</button
      >
      <button class="btn ghost" type="button" onclick={onCancelRemove}
        >{t["remove.cancel"]}</button
      >
    {/if}
  </div>
{/if}

{#if album.leaving}
  <div
    class="sheet"
    role="alertdialog"
    aria-modal="true"
    aria-labelledby="leaving-text"
  >
    <p id="leaving-text">{t["album.leaving"]}</p>
    <button class="btn" type="button" onclick={onStay}
      >{t["album.leaving.stay"]}</button
    >
    <button class="btn ghost" type="button" onclick={onLeave}
      >{t["album.leaving.go"]}</button
    >
  </div>
{/if}

{#if album.review !== null}
  <Review
    rows={album.review.rows}
    {onCaption}
    {onUnpick}
    onCancel={onCancelReview}
    onSend={onSendReview}
  />
{/if}

{#if album.viewer !== null}
  {@const item = viewable[album.viewer.index]}
  <Viewer
    viewer={album.viewer}
    standIn={item?.thumb.kind === "ready" ? item.thumb.picture : null}
    count={viewable.length}
    watermark=""
    caption={item?.caption ?? null}
    onClose={onCloseViewer}
  />
{/if}

<style>
  .album {
    padding-top: 12px;
    gap: 20px;
  }
  .top {
    display: flex;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  h1 {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .failed-text {
    color: var(--danger);
    font-weight: 400;
  }
  .ending,
  .pending {
    margin: 0;
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    border: 2px solid var(--accent);
  }
  .sharing {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .sharing .btn.ghost {
    width: 100%;
  }
  .add {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .add label {
    text-align: center;
  }
  .add .note {
    margin: 0;
  }
  .add:focus-within label {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }
  .cells {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  @media (min-width: 640px) {
    .cells {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  .sheet {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    max-width: 616px;
    margin: 0 auto;
    background: #fff;
    border: 2px solid var(--ink);
    border-radius: var(--radius);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .sheet h2 {
    margin: 0;
    font-size: 24px;
  }
  .sheet p {
    margin: 0;
  }
  .sheet .btn.ghost {
    width: 100%;
  }
  .btn.danger {
    background: var(--danger);
    border-color: var(--danger);
  }
</style>
