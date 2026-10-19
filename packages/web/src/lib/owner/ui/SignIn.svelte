<script lang="ts">
  /*
   * Sign-in on a new device (flows §3.3; the Signin board). No password
   * policy here (brief §12). The address is sent exactly as typed: the input
   * is type="text", because type="email" strips leading and trailing
   * whitespace before the value is read, and the client must not transform
   * the address at all (api-sketch §7.5).
   */
  import { en } from "$lib/copy/en";
  import type { SigninNotice, SigninPhase } from "$lib/owner/session";
  import Alert from "$lib/ui/Alert.svelte";
  import DerivationWait from "$lib/ui/DerivationWait.svelte";
  import PasswordField from "./PasswordField.svelte";
  import Paused from "./Paused.svelte";

  let {
    phase,
    notice,
    initialEmail,
    pausedUntil,
    onSubmit,
    onRetry,
    onSignup,
  }: {
    phase: SigninPhase;
    notice: SigninNotice;
    initialEmail: string;
    pausedUntil: number | null;
    onSubmit: (email: string, password: string) => void;
    onRetry: (email: string) => void;
    onSignup: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let email = $state(initialEmail);
  let password = $state("");
  const busy = $derived(phase === "busy" || phase === "deriving");
  const ready = $derived(email.trim() !== "" && password !== "");

  // A failed or paused attempt empties the password field, as the board does.
  // A 429 keeps the address (flows §0).
  $effect(() => {
    if (phase === "failed" || phase === "unavailable" || phase === "paused") password = "";
  });

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    if (busy || !ready || phase === "paused") return;
    onSubmit(email, password);
  }
</script>

<main class="screen">
  <h1>{en["signin.title"]}</h1>
  {#if notice === "session-ended"}
    <p class="note" role="status">{en["session.ended"]}</p>
  {:else if notice === "signed-out"}
    <p class="note" role="status">{en["signed-out"]}</p>
  {/if}

  {#if phase === "unavailable"}
    <Alert text={en["signin.unavailable"]} />
    <button class="btn" type="button" onclick={() => onRetry(email)}>{en["signin.retry"]}</button>
  {:else}
    <form onsubmit={submit} novalidate>
      <fieldset disabled={busy}>
        <div class="group">
          <label for="signin-email">{en["signin.email.label"]}</label>
          <input
            id="signin-email"
            class="field"
            class:invalid={phase === "failed"}
            type="text"
            inputmode="email"
            autocomplete="email"
            autocapitalize="none"
            spellcheck="false"
            bind:value={email}
          />
        </div>
        <PasswordField id="signin-password" label={en["signin.password.label"]} autocomplete="current-password" invalid={phase === "failed"} bind:value={password} />
      </fieldset>

      {#if phase === "failed"}
        <Alert text={en["signin.failed"]} />
      {:else if phase === "paused" && pausedUntil !== null}
        <Paused until={pausedUntil} />
      {/if}

      {#if phase === "deriving"}
        <DerivationWait layout="stacked" />
      {:else if phase === "busy"}
        <p class="note" role="status">{en["signin.busy"]}</p>
      {:else}
        <button class="btn" type="submit" disabled={!ready || phase === "paused"}>{en["signin.submit"]}</button>
      {/if}
    </form>
  {/if}

  {#if !busy}
    <div class="bottom">
      <button class="btn ghost" type="button" onclick={onSignup}>{en["signin.to-signup"]}</button>
    </div>
  {/if}
</main>

<style>
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
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
</style>
