<script lang="ts">
  /*
   * The access log (flows §3.10): entries newest first, a page at a time by
   * next_before, each photo shown by the owner's own thumbnail. "Opened",
   * only the permitted column of api-sketch §11.6, and the sparse-log line.
   */
  import { copy, format } from "$lib/copy/language.svelte";
  import type { LogEntryView, LogScreen } from "$lib/owner/people";
  import LogThumb from "./LogThumb.svelte";

  const t = $derived(copy());
  const fmt = $derived(format());

  let {
    log,
    onBack,
    onMore,
  }: {
    log: LogScreen;
    onBack: () => void;
    onMore: () => void;
  } = $props();

  const now = new Date();

  const title = $derived(log.recipientId === null ? t["log.title"] : log.recipientLabel === null ? t["log.title.person.unnamed"] : t["log.title.person"](log.recipientLabel));

  function line(e: LogEntryView): string {
    if (e.event === "album_opened") return e.label === null ? t["log.entry.album.unnamed"] : t["log.entry.album"](e.label);
    return e.label === null ? t["log.entry.photo.unnamed"] : t["log.entry.photo"](e.label);
  }
</script>

<main class="screen log">
  <div class="top">
    <button class="btn ghost back" type="button" onclick={onBack}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M15 5l-7 7 7 7"></path></svg
      >
      <span>{t["log.back"]}</span>
    </button>
  </div>
  <h1>{title}</h1>
  <p class="note">{t["log.sparse"]}</p>

  {#if log.phase === "loading"}
    <p class="note" role="status">{t["log.loading"]}</p>
  {:else if log.entries.length === 0}
    <p class="note">{log.recipientId === null ? t["log.none"] : t["log.none.person"]}</p>
  {:else}
    <ol class="entries">
      {#each log.entries as e (e.id)}
        <li class="entry" data-entry={e.id}>
          {#if e.mediaId !== null && log.photos[e.mediaId] !== undefined}
            <LogThumb photo={log.photos[e.mediaId]!} />
          {/if}
          <div class="what">
            <p>{line(e)}</p>
            <p class="when"><time datetime={e.occurredAt}>{fmt.logTime(new Date(e.occurredAt), now)}</time></p>
          </div>
        </li>
      {/each}
    </ol>
    {#if log.phase === "more"}
      <p class="note" role="status">{t["log.more.busy"]}</p>
    {:else if log.hasMore}
      <button class="btn ghost" type="button" onclick={onMore}>{t["log.more"]}</button>
    {/if}
  {/if}
  <p class="note">{t["log.counts"]}</p>
</main>

<style>
  .log {
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
  .entries {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .entry {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    background: #fff;
    border-radius: var(--radius);
    padding: 12px;
  }
  .what {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .what p {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .when {
    color: var(--ink-muted);
    font-size: 17px;
  }
</style>
