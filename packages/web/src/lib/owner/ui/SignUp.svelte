<script lang="ts">
  /*
   * Signup (flows §3.2; the Signup board). The password policy is checked by
   * the session, here and nowhere else (brief §12). signup.loss is on screen
   * before submission. The address input is type="text" for SignIn.svelte's
   * reason: it is sent exactly as typed.
   */
  import { en } from "$lib/copy/en";
  import type { SignupPhase } from "$lib/owner/session";
  import Alert from "$lib/ui/Alert.svelte";
  import DerivationWait from "$lib/ui/DerivationWait.svelte";
  import PasswordField from "./PasswordField.svelte";
  import Paused from "./Paused.svelte";

  let {
    phase,
    pausedUntil,
    onSubmit,
    onSignin,
  }: {
    phase: SignupPhase;
    pausedUntil: number | null;
    onSubmit: (email: string, password: string) => void;
    onSignin: (email: string) => void;
  } = $props();

  let email = $state("");
  let password = $state("");
  const busy = $derived(phase === "busy" || phase === "deriving");
  const ready = $derived(email.trim() !== "" && password !== "");
  const passwordProblem = $derived(
    phase === "too-short"
      ? en["signup.too-short"]
      : phase === "too-long"
        ? en["signup.too-long"]
        : phase === "common"
          ? en["signup.common"]
          : phase === "invalid"
            ? en["signup.invalid"]
            : null,
  );

  // A 429 empties the password field and keeps the address (flows §0).
  $effect(() => {
    if (phase === "paused") password = "";
  });

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (busy || !ready || phase === "paused") return;
    onSubmit(email, password);
  }
</script>

<main class="screen">
  <h1>{en["signup.title"]}</h1>
  <form onsubmit={submit} novalidate>
    <fieldset disabled={busy}>
      <div class="group">
        <label for="signup-email">{en["signup.email.label"]}</label>
        <input
          id="signup-email"
          class="field"
          class:invalid={phase === "taken"}
          type="text"
          inputmode="email"
          autocomplete="email"
          autocapitalize="none"
          spellcheck="false"
          bind:value={email}
        />
        {#if phase === "taken"}
          <Alert text={en["signup.taken"]} />
          <button class="btn ghost" type="button" onclick={() => onSignin(email)}>{en["signup.taken.signin"]}</button>
        {/if}
      </div>
      <div class="group">
        <PasswordField
          id="signup-password"
          label={en["signup.password.label"]}
          autocomplete="new-password"
          invalid={passwordProblem !== null}
          describedby="signup-policy"
          bind:value={password}
        />
        <p id="signup-policy" class="note">{en["signup.policy"]}</p>
        {#if passwordProblem !== null}
          <Alert text={passwordProblem} />
        {/if}
      </div>
    </fieldset>

    <div class="loss">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><circle cx="8" cy="15" r="4"></circle><path d="M11 12l9-9"></path><path d="M17 6l3 3"></path></svg
      >
      <strong>{en["signup.loss"]}</strong>
    </div>

    {#if phase === "failed"}
      <Alert text={en["signup.failed"]} />
    {:else if phase === "paused" && pausedUntil !== null}
      <Paused until={pausedUntil} />
    {/if}

    {#if phase === "deriving"}
      <DerivationWait />
    {:else if phase === "busy"}
      <p class="note" role="status">{en["signup.busy"]}</p>
    {:else}
      <button class="btn" type="submit" disabled={!ready || phase === "paused"}>{en["signup.submit"]}</button>
    {/if}
  </form>

  {#if !busy}
    <div class="bottom">
      <button class="btn ghost" type="button" onclick={() => onSignin("")}>{en["signup.to-signin"]}</button>
    </div>
  {/if}
</main>

<style>
  .screen {
    padding-top: 36px;
    gap: 20px;
  }
  form,
  fieldset {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    min-width: 0;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .loss {
    background: #f1e7d6;
    border: 2px solid var(--ink-muted);
    border-radius: var(--radius);
    padding: 16px;
    display: flex;
    gap: 12px;
    align-items: flex-start;
  }
  .loss svg {
    flex: none;
    margin-top: 2px;
  }
  .loss strong {
    font-weight: 700;
  }
</style>
