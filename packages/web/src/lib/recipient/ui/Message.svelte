<script lang="ts">
  /* A screen that is one sentence: revoked, not recognised, dead, newer version, device failed, loading. */
  let { text, role = "alert", kind = "plain" }: { text: string; role?: "alert" | "status"; kind?: "plain" | "closed" | "device" } = $props();
</script>

<main class="screen centred" {role}>
  {#if kind === "closed"}
    <svg width="72" height="72" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"
      ><rect x="12" y="8" width="24" height="30"></rect><path d="M24 8v30"></path><path d="M8 44h32"></path></svg
    >
  {:else if kind === "device"}
    <div class="device" aria-hidden="true">
      <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"
        ><rect x="6" y="2" width="12" height="20" rx="2.5"></rect><path d="M10 9.5l4 4M14 9.5l-4 4"></path><path d="M11 18.5h2"></path></svg
      >
    </div>
  {/if}
  <h1>{text}</h1>
</main>

<style>
  svg {
    color: var(--ink-muted);
  }
  .device {
    width: 112px;
    height: 112px;
    border-radius: 24px;
    background: var(--paper);
    border: 2px solid var(--ink-muted);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .device svg {
    color: var(--ink);
  }
</style>
