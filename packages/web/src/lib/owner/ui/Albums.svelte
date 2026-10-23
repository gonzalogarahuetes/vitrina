<script lang="ts">
  /*
   * The album list (flows §3.4), create album (§3.5), logout (§3.11) and the
   * session-expiry warning (§3.12). An album whose key or title will not open
   * is listed with its failure, never dropped. Counts are items, not photos.
   */
  import { resolve } from "$app/paths";
  import { en, sessionEndTime } from "$lib/copy/en";
  import type { AlbumView, CreatePhase, Expiry, LogoutScope } from "$lib/owner/session";
  import Alert from "$lib/ui/Alert.svelte";

  let {
    phase,
    albums,
    create,
    signingOut,
    expiry,
    onOpenCreate,
    onCloseCreate,
    onCreate,
    onLogout,
    onOpen,
  }: {
    phase: "loading" | "ready";
    albums: readonly AlbumView[];
    create: CreatePhase;
    signingOut: LogoutScope | null;
    expiry: Expiry | null;
    onOpenCreate: () => void;
    onCloseCreate: () => void;
    onCreate: (title: string) => void;
    onLogout: (scope: LogoutScope) => void;
    onOpen: (id: string) => void;
  } = $props();

  let title = $state("");
  const creating = $derived(create === "creating");
  const busy = $derived(signingOut !== null);

  // A closed form starts empty next time.
  $effect(() => {
    if (create === "closed") title = "";
  });

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (!creating) onCreate(title);
  }
</script>

<main class="screen albums" inert={busy}>
  <h1>{en["albums.title"]}</h1>

  {#if expiry?.ending}
    <p class="ending" role="status">{en["session.ending"](sessionEndTime(expiry.endsAt))}</p>
  {/if}

  {#if phase === "loading"}
    <p class="note" role="status">{en["albums.loading"]}</p>
  {:else}
    {#if create === "closed"}
      <button class="btn" type="button" onclick={onOpenCreate}>{en["album.create"]}</button>
    {:else}
      <form class="create" onsubmit={submit} novalidate>
        <fieldset disabled={creating}>
          <label for="album-title">{en["album.title.label"]}</label>
          <input
            id="album-title"
            class="field"
            class:invalid={create === "empty" || create === "too-long"}
            type="text"
            autocomplete="off"
            aria-describedby="album-title-note"
            bind:value={title}
          />
          <p id="album-title-note" class="note">{en["album.title"]}</p>
        </fieldset>
        {#if create === "empty"}
          <Alert text={en["album.title.empty"]} />
        {:else if create === "too-long"}
          <Alert text={en["album.title.too-long"]} />
        {:else if create === "failed"}
          <Alert text={en["album.create.failed"]} />
        {/if}
        {#if creating}
          <p class="note" role="status">{en["album.create.busy"]}</p>
        {:else}
          <button class="btn" type="submit">{en["album.create.submit"]}</button>
          <button class="btn ghost" type="button" onclick={onCloseCreate}>{en["album.create.cancel"]}</button>
        {/if}
      </form>
    {/if}

    {#if albums.length === 0}
      <p class="note">{en["albums.empty"]}</p>
    {:else}
      <ul class="list">
        {#each albums as album (album.id)}
          <li class="album" class:failed={album.failed !== null} data-album={album.id}>
            {#if album.failed === "key"}
              <!-- Its key would not open: there is nothing this device can show inside it. -->
              <span class="name failed-text">{en["albums.failed.key"]}</span>
              <span class="count">{en["albums.count"](album.mediaCount)}</span>
            {:else}
              <button
                class="open"
                type="button"
                aria-label={album.title === null ? en["albums.open.untitled.a11y"] : en["albums.open.a11y"](album.title)}
                onclick={() => onOpen(album.id)}
              >
                {#if album.failed === null}
                  <span class="name">{album.title}</span>
                {:else}
                  <span class="name failed-text">{en["albums.failed.title"]}</span>
                {/if}
                <span class="count">{en["albums.count"](album.mediaCount)}</span>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  <div class="bottom out">
    {#if busy}
      <p class="note" role="status">{en["logout.busy"]}</p>
    {:else}
      <button class="btn ghost" type="button" onclick={() => onLogout("device")}>{en["logout.device"]}</button>
      <button class="btn ghost" type="button" onclick={() => onLogout("everywhere")}>{en["logout.everywhere"]}</button>
    {/if}
    <a class="licences-link" href={resolve("/licences")}>{en["licences.link"]}</a>
  </div>
</main>

<style>
  .albums {
    padding-top: 40px;
    gap: 20px;
  }
  .ending {
    margin: 0;
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    border: 2px solid var(--accent);
  }
  .create,
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .album {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 16px;
    border-radius: var(--radius);
    background: #fff;
    border: 2px solid var(--surface);
    overflow-wrap: anywhere;
  }
  .album.failed {
    background: var(--danger-soft);
    border-color: var(--danger);
  }
  .name {
    font-weight: 700;
  }
  .open {
    all: unset;
    display: flex;
    flex-direction: column;
    gap: 4px;
    cursor: pointer;
    margin: -16px;
    padding: 16px;
    border-radius: var(--radius);
  }
  .open:focus-visible {
    outline: 3px solid var(--focus);
    outline-offset: 2px;
  }
  .failed-text {
    color: var(--danger);
    font-weight: 400;
  }
  .count {
    color: var(--ink-muted);
  }
  .licences-link {
    align-self: center;
    margin-top: 8px;
    color: var(--ink-muted);
  }
  .out {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .out .btn.ghost {
    width: 100%;
  }
</style>
