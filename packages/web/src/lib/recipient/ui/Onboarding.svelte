<script lang="ts">
  import { en } from "$lib/copy/en";

  let { onContinue }: { onContinue: () => void } = $props();
</script>

<main class="screen">
  <svg width="72" height="72" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"
    ><rect x="15" y="8" width="18" height="30"></rect><path d="M15 8 L7 12 V42 L15 38"></path><path d="M33 8 L41 12 V42 L33 38"></path><path d="M5 44h38"></path></svg
  >
  <!-- Brief §16, verbatim. Nothing else on this screen may soften its third paragraph. -->
  <div class="text">
    {#each en["onboarding.text"] as paragraph (paragraph)}
      <p>{paragraph}</p>
    {/each}
  </div>
  <div class="bottom">
    <button class="btn" type="button" onclick={onContinue}>{en["onboarding.continue"]}</button>
  </div>
</main>

<style>
  svg {
    color: var(--accent);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 18px;
    font-size: var(--text-lead);
    line-height: 1.5;
    text-wrap: pretty;
  }
  p {
    margin: 0;
  }
</style>
