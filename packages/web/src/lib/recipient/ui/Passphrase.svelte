<script lang="ts">
  import { copy } from "$lib/copy/language.svelte";
  import type { PassphrasePhase } from "$lib/recipient/session";
  import DerivationWait from "$lib/ui/DerivationWait.svelte";

  const t = $derived(copy());

  let { phase, onSubmit }: { phase: PassphrasePhase; onSubmit: (words: readonly string[]) => void } = $props();

  /* Five fields, as the prototype draws them. Extra words typed into one field are kept: they are joined with spaces. */
  const FIELDS = 5;
  let words = $state<string[]>(Array.from({ length: FIELDS }, () => ""));
  const busy = $derived(phase === "deriving" || phase === "loading");

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (busy) return;
    onSubmit(words.map((w) => w.trim()).filter((w) => w !== ""));
  }

</script>

<main class="screen">
  <h1>{t["recipient.passphrase.title"]}</h1>
  <form onsubmit={submit} novalidate>
    <fieldset disabled={busy}>
      <legend>{t["recipient.passphrase.label"]}</legend>
      <p class="hint">{t["pass.entry"]}</p>
      {#each words as _, i (i)}
        <div class="row">
          <label for="word-{i}"><span aria-hidden="true">{i + 1}</span><span class="visually-hidden">{t["recipient.passphrase.word"](i + 1)}</span></label>
          <input
            id="word-{i}"
            class="field"
            class:invalid={phase === "wrong" || (phase === "empty" && words[i]?.trim() === "")}
            type="text"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            aria-invalid={phase === "wrong"}
            bind:value={words[i]}
          />
        </div>
      {/each}
    </fieldset>

    {#if phase === "empty"}
      <div class="alert" role="alert">{@render warn()}<span>{t["pass.empty"]}</span></div>
    {:else if phase === "wrong"}
      <div class="alert" role="alert">{@render warn()}<span>{t["pass.wrong"]}</span></div>
    {/if}

    {#if phase === "deriving"}
      <!-- The derivation wait (flows §2): no progress figure, the input cannot be edited or resubmitted. -->
      <DerivationWait />
    {:else}
      <button class="btn" type="submit" disabled={busy}>{t["recipient.passphrase.submit"]}</button>
    {/if}
  </form>

  <div class="bottom lost">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
      ><circle cx="8" cy="15" r="4"></circle><path d="M11 12l9-9"></path><path d="M17 6l3 3"></path></svg
    >
    <span>{t["pass.lost"]}</span>
  </div>
</main>

{#snippet warn()}
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" class="warn"
    ><circle cx="12" cy="12" r="10"></circle><path d="M12 7v6"></path><path d="M12 17h.01"></path></svg
  >
{/snippet}

<style>
  .screen {
    padding-top: 40px;
    gap: 18px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 4px;
  }
  .hint {
    margin: 0 0 6px;
    color: var(--ink-muted);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  label {
    width: 24px;
    flex: none;
    font-weight: 700;
    font-size: 22px;
  }
  .field {
    width: 100%;
    min-height: var(--target);
    border: 2px solid var(--ink-muted);
    border-radius: 12px;
    background: #fff;
    font: 400 22px/1.2 var(--font);
    color: var(--ink);
    padding: 12px 16px;
  }
  .field.invalid {
    border-color: var(--danger);
  }
  .field:disabled {
    background: #eeebe4;
    color: var(--ink-muted);
  }
  .warn {
    flex: none;
    margin-top: 3px;
  }
  .lost {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    border-top: 2px solid var(--surface);
    padding-top: 16px;
  }
  .lost svg {
    flex: none;
    margin-top: 2px;
    color: var(--ink-muted);
  }
</style>
