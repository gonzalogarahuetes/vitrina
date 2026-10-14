<script lang="ts">
  import { api, health } from "$lib/api";

  // Placeholder, not a screen: proves the WASM loaded (the layout) and the
  // API is reachable cross-origin through the one client.
  const result = health(api).then(
    () => "ok",
    (e: unknown) => (e instanceof Error ? e.name : "Error"),
  );
</script>

<p data-state="envelope-ready">envelope: ready</p>
{#await result}
  <p>health: …</p>
{:then status}
  <p data-state="health">health: {status}</p>
{/await}
