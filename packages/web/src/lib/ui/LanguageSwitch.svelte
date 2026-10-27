<script lang="ts">
  /*
   * The interface language, on every screen (brief §15.1: an explicit choice).
   * Each language is named in its own words and marked with its own lang, so a
   * screen reader says "Español" in Spanish whatever the page is in. A choice
   * lasts for this visit and is stored nowhere (lib/copy/language.svelte.ts).
   *
   * `compact` offers only the languages not in use, for the photo viewer's top
   * row, where a phone has room beside Back for one more button and no more.
   */
  import { LANGUAGES } from "$lib/copy";
  import { autonym } from "$lib/copy/format";
  import { copy, language } from "$lib/copy/language.svelte";

  let { compact = false }: { compact?: boolean } = $props();

  const t = $derived(copy());
  const offered = $derived(compact ? LANGUAGES.filter((l) => l !== language.current) : LANGUAGES);
</script>

<nav class="language" aria-label={t["language.label"]} data-language-switch>
  {#each offered as code (code)}
    <button
      type="button"
      class="choice"
      class:on={!compact && language.current === code}
      lang={code}
      aria-pressed={compact ? undefined : language.current === code}
      onclick={() => language.set(code)}>{autonym(code)}</button
    >
  {/each}
</nav>

<style>
  .language {
    display: flex;
    gap: 4px;
  }
  .choice {
    min-height: var(--target);
    min-width: var(--target);
    padding: 8px 14px;
    border: 2px solid transparent;
    border-radius: var(--radius);
    background: transparent;
    color: var(--accent);
    font-size: 18px;
    cursor: pointer;
  }
  .choice:hover {
    background: var(--accent-soft);
  }
  .choice.on {
    border-color: var(--accent);
    font-weight: 700;
    cursor: default;
  }
</style>
