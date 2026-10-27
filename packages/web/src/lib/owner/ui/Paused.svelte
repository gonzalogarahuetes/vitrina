<script lang="ts">
  /*
   * flows §0's credential-route 429: a countdown to `until` (ms, on the
   * device's clock). Display only: the session decides when submitting
   * resumes. Above a minute the text changes once a minute, so a screen
   * reader is not read a new sentence every second.
   */
  import { onMount } from "svelte";
  import { copy, format } from "$lib/copy/language.svelte";

  const t = $derived(copy());
  const fmt = $derived(format());

  let { until }: { until: number } = $props();

  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(t);
  });
  const text = $derived(t["credential.paused"](fmt.pauseLeft(until - now)));
</script>

<div class="paused" role="status">
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"
    ><circle cx="12" cy="12" r="10"></circle><path d="M12 7v5l3 2"></path></svg
  >
  <span>{text}</span>
</div>

<style>
  .paused {
    display: flex;
    gap: 10px;
    align-items: flex-start;
    color: var(--ink);
  }
  svg {
    flex: none;
    margin-top: 3px;
  }
</style>
