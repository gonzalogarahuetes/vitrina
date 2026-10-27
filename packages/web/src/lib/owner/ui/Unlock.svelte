<script lang="ts">
  /*
   * Unlock (flows §3.1; the Main board). It says only "Unlock": no email is
   * stored, so none can be shown. No password policy. A wrong password is the
   * tag failing locally, so nothing is counted and the copy says nothing about
   * attempts. Sign-out is offered for a shared device or the wrong account.
   */
  import { copy } from "$lib/copy/language.svelte";
  import type { UnlockPhase } from "$lib/owner/session";
  import Alert from "$lib/ui/Alert.svelte";
  import DerivationWait from "$lib/ui/DerivationWait.svelte";
  import PasswordField from "./PasswordField.svelte";

  const t = $derived(copy());

  let {
    phase,
    signingOut,
    onSubmit,
    onRetry,
    onAskSignOut,
    onSignOut,
  }: {
    phase: UnlockPhase;
    signingOut: boolean;
    onSubmit: (password: string) => void;
    onRetry: () => void;
    onAskSignOut: (open: boolean) => void;
    onSignOut: () => void;
  } = $props();

  let password = $state("");
  const busy = $derived(phase === "deriving");

  $effect(() => {
    if (phase === "wrong") password = "";
  });

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (busy) return;
    onSubmit(password);
  }
</script>

<main class="screen unlock" inert={signingOut}>
  <h1>{t["unlock.prompt"]}</h1>
  {#if phase === "unavailable"}
    <Alert text={t["unlock.unavailable"]} />
    <button class="btn" type="button" onclick={onRetry}>{t["unlock.retry"]}</button>
  {:else}
    <form onsubmit={submit} novalidate>
      <fieldset disabled={busy}>
        <PasswordField id="unlock-password" label={t["unlock.password.label"]} autocomplete="current-password" invalid={phase === "wrong"} bind:value={password} />
      </fieldset>
      {#if phase === "wrong"}
        <Alert text={t["unlock.wrong"]} />
      {:else if phase === "empty"}
        <Alert text={t["unlock.empty"]} />
      {/if}
      {#if busy}
        <DerivationWait layout="stacked" />
      {:else}
        <button class="btn" type="submit">{t["unlock.submit"]}</button>
      {/if}
    </form>
  {/if}
  <div class="bottom">
    <button class="btn ghost" type="button" disabled={busy} onclick={() => onAskSignOut(true)}>{t["unlock.signout"]}</button>
  </div>
</main>

{#if signingOut}
  <div class="scrim">
    <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="signout-title">
      <h2 id="signout-title">{t["unlock.signout.confirm"]}</h2>
      <p>{t["unlock.signout.consequence"]}</p>
      <button class="btn" type="button" onclick={onSignOut}>{t["unlock.signout.yes"]}</button>
      <button class="btn ghost" type="button" onclick={() => onAskSignOut(false)}>{t["unlock.signout.no"]}</button>
    </div>
  </div>
{/if}

<style>
  .unlock {
    padding-top: 88px;
    gap: 32px;
  }
  .unlock h1 {
    font-size: 38px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  .scrim {
    position: fixed;
    inset: 0;
    background: rgba(28, 27, 25, 0.6);
    display: flex;
    align-items: flex-end;
    justify-content: center;
    z-index: 3;
  }
  .sheet {
    background: var(--paper);
    width: 100%;
    max-width: 640px;
    border-radius: 24px 24px 0 0;
    padding: 32px 28px 36px;
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .sheet h2 {
    margin: 0;
    font-size: 26px;
  }
  .sheet p {
    margin: 0 0 8px;
  }
  .btn.ghost {
    width: 100%;
  }
</style>
