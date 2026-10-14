<script lang="ts">
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  let { data, children }: { data: LayoutData; children: Snippet } = $props();
</script>

{#if data.envelope.status === "ready"}
  {@render children()}
{:else}
  <!-- ⟦copy: derive.failed⟧ belongs to the screens; this is the state, not its text. -->
  <p data-state="envelope-unavailable">derive.failed</p>
{/if}
