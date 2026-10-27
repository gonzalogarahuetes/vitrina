<script lang="ts">
  import "$lib/theme.css";
  import { copy } from "$lib/copy/language.svelte";
  import LanguageSwitch from "$lib/ui/LanguageSwitch.svelte";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  const t = $derived(copy());

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

<!-- Every screen, the could-not-derive one included. The photo viewer, which covers this, carries its own. -->
<div class="language-bar">
  <LanguageSwitch />
</div>

{#if data.envelope.status === "ready"}
  {@render children()}
{:else}
  <!-- Flows §2's "could not derive" family: never shown as a wrong password. -->
  <main class="screen centred" role="alert" data-state="envelope-unavailable">
    <h1>{t["derive.failed"]}</h1>
  </main>
{/if}

<style>
  .language-bar {
    max-width: 960px;
    height: var(--language-bar);
    margin: 0 auto;
    padding: 4px 12px 0;
    display: flex;
    justify-content: flex-end;
  }
</style>
