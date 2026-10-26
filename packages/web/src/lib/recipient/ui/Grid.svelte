<script lang="ts">
  import { en } from "$lib/copy/en";
  import type { Item } from "$lib/recipient/session";
  import GridCell from "./GridCell.svelte";

  let {
    title,
    loading,
    items,
    watermark,
    onOpen,
    onRetry,
  }: {
    title: string;
    loading: boolean;
    items: readonly Item[];
    watermark: string;
    onOpen: (index: number) => void;
    onRetry: (id: string) => void;
  } = $props();
</script>

<main class="grid-screen">
  <header>
    {#if loading}
      <p role="status">{en["open.loading"]}</p>
    {:else}
      <h1>{title}</h1>
    {/if}
  </header>

  {#if !loading && items.length === 0}
    <div class="empty" role="status">
      <svg width="72" height="72" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"
        ><rect x="8" y="10" width="32" height="28" rx="3"></rect><path d="M8 30h32"></path></svg
      >
      <p>{en["grid.empty"]}</p>
    </div>
  {:else}
    <div class="cells">
      {#each items as item, i (item.id)}
        <GridCell {item} index={i} count={items.length} {watermark} onOpen={() => onOpen(i)} onRetry={() => onRetry(item.id)} />
      {/each}
    </div>
  {/if}
</main>

<style>
  .grid-screen {
    max-width: 960px;
    margin: 0 auto;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 40px 16px 20px;
  }
  h1 {
    margin: 0;
    font-size: 26px;
    line-height: 1.2;
    overflow-wrap: anywhere;
  }
  header p {
    margin: 0;
  }
  .cells {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    padding: 0 16px 24px;
  }
  @media (min-width: 640px) {
    .cells {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  .empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: flex-start;
    gap: 24px;
    padding: 28px 28px 120px;
  }
  .empty svg {
    color: var(--ink-muted);
  }
  .empty p {
    margin: 0;
    font-size: 21px;
  }
</style>
