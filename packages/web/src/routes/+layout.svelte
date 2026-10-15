<script lang="ts">
  import "$lib/theme.css";
  import { en } from "$lib/copy/en";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

{#if data.envelope.status === "ready"}
  {@render children()}
{:else}
  <!-- Flows §2's "could not derive" family: never shown as a wrong password. -->
  <main class="screen centred" role="alert" data-state="envelope-unavailable">
    <h1>{en["derive.failed"]}</h1>
  </main>
{/if}
