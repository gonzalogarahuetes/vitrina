<script lang="ts">
  /*
   * Invited people and revoke (flows §3.9): every recipient from the
   * access-log summary, revoked ones marked, with what each has opened in
   * §11.6's permitted words and the sparse-log line beside the counts.
   */
  import { copy, format } from "$lib/copy/language.svelte";
  import type { PeopleScreen, PersonView } from "$lib/owner/people";
  import Alert from "$lib/ui/Alert.svelte";

  const t = $derived(copy());
  const fmt = $derived(format());

  let {
    people,
    onBack,
    onRevoke,
    onCancelRevoke,
    onConfirmRevoke,
    onLog,
  }: {
    people: PeopleScreen;
    onBack: () => void;
    onRevoke: (id: string) => void;
    onCancelRevoke: () => void;
    onConfirmRevoke: () => void;
    onLog: (recipientId: string | null) => void;
  } = $props();

  const now = new Date();
  const confirming = $derived(people.revoke === null ? undefined : people.people.find((p) => p.id === people.revoke?.id));

  const name = (p: PersonView): string => p.label ?? t["people.unreadable"];
</script>

<main class="screen people" inert={people.revoke !== null}>
  <div class="top">
    <button class="btn ghost back" type="button" onclick={onBack}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M15 5l-7 7 7 7"></path></svg
      >
      <span>{t["people.back"]}</span>
    </button>
  </div>
  <h1>{t["people.title"]}</h1>

  {#if people.refreshed}
    <p class="notice" role="status">{t["people.refreshed"]}</p>
  {/if}
  {#if people.justRevoked !== null}
    <p class="notice" role="status">{t["revoke.done"]}</p>
  {/if}

  {#if people.phase === "loading"}
    <p class="note" role="status">{t["people.loading"]}</p>
  {:else if people.people.length === 0}
    <p class="note">{t["people.empty"]}</p>
  {:else}
    <p class="note">{t["log.sparse"]}</p>
    <ul class="list">
      {#each people.people as p (p.id)}
        <li class="person" class:revoked={p.revokedAt !== null} data-recipient={p.id}>
          <h2 class:failed-text={p.label === null}>{name(p)}</h2>
          {#if p.revokedAt !== null}
            <p class="tag">{t["people.revoked"](fmt.logTime(new Date(p.revokedAt), now))}</p>
          {/if}
          <p>{t["log.summary.opens"](p.albumOpens)}</p>
          {#if p.mediaOpened > 0}
            <p>{t["log.summary.photos"](p.mediaOpened)}</p>
          {/if}
          {#if p.lastOpenedAt !== null}
            <p>{t["log.summary.last"](fmt.logDay(new Date(p.lastOpenedAt), now))}</p>
          {/if}
          <div class="row">
            {#if p.albumOpens > 0}
              <button class="btn ghost" type="button" onclick={() => onLog(p.id)}>{p.label === null ? t["people.log.person.unnamed"] : t["people.log.person"](p.label)}</button>
            {/if}
            {#if p.revokedAt === null}
              <button class="btn ghost danger" type="button" onclick={() => onRevoke(p.id)}>{t["people.revoke"]}</button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <p class="note">{t["log.counts"]}</p>
    <button class="btn" type="button" onclick={() => onLog(null)}>{t["people.log"]}</button>
  {/if}
</main>

{#if people.revoke !== null}
  <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="revoke-title" aria-describedby="revoke-text">
    <h2 id="revoke-title">{confirming?.label == null ? t["revoke.confirm.title.unnamed"] : t["revoke.confirm.title"](confirming.label)}</h2>
    <p id="revoke-text">{confirming?.label == null ? t["revoke.confirm.unnamed"] : t["revoke.confirm"](confirming.label)}</p>
    {#if people.revoke.failed}
      <Alert text={t["revoke.failed"]} />
    {/if}
    {#if people.revoke.busy}
      <p class="note" role="status">{t["revoke.busy"]}</p>
    {:else}
      <button class="btn danger" type="button" onclick={onConfirmRevoke}>{t["revoke.yes"]}</button>
      <button class="btn ghost" type="button" onclick={onCancelRevoke}>{t["revoke.no"]}</button>
    {/if}
  </div>
{/if}

<style>
  .people {
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
  .notice {
    margin: 0;
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    border: 2px solid var(--accent);
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .person {
    background: #fff;
    border-radius: var(--radius);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .person.revoked {
    background: var(--surface);
  }
  .person h2 {
    margin: 0;
    font-size: 22px;
    overflow-wrap: anywhere;
  }
  .person p {
    margin: 0;
  }
  .failed-text {
    color: var(--danger);
    font-weight: 400;
  }
  .tag {
    font-weight: 700;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    margin-top: 8px;
  }
  .row .btn {
    flex: 1 1 auto;
  }
  /* Outline, not filled: the filled .btn.danger below would otherwise win the
     background and leave danger-coloured text on a danger-coloured button. */
  .btn.ghost.danger {
    background: transparent;
    color: var(--danger);
    border-color: var(--danger);
  }
  .btn.ghost.danger:hover {
    background: var(--danger-soft);
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
