<script lang="ts">
  /*
   * A password input with a show/hide toggle, as the Signup, Signin and Main
   * boards draw it. The value is a JavaScript string held by the parent. It
   * cannot be wiped (api-sketch §8.4), so the parent only empties the field.
   */
  import { en } from "$lib/copy/en";

  let {
    id,
    label,
    value = $bindable(""),
    autocomplete,
    disabled = false,
    invalid = false,
    describedby = undefined,
  }: {
    id: string;
    label: string;
    value?: string;
    autocomplete: "current-password" | "new-password";
    disabled?: boolean;
    invalid?: boolean;
    describedby?: string | undefined;
  } = $props();

  let shown = $state(false);
</script>

<div class="group">
  <label for={id}>{label}</label>
  <div class="row">
    <input
      {id}
      class="field"
      class:invalid
      type={shown ? "text" : "password"}
      {autocomplete}
      autocapitalize="none"
      spellcheck="false"
      aria-invalid={invalid}
      aria-describedby={describedby}
      {disabled}
      bind:value
    />
    <button class="iconbtn" type="button" aria-label={shown ? en["password.hide"] : en["password.show"]} aria-pressed={shown} {disabled} onclick={() => (shown = !shown)}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
        ><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>{#if shown}<path d="M4 4l16 16"></path>{/if}</svg
      >
    </button>
  </div>
</div>

<style>
  .group {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .row {
    display: flex;
    gap: 10px;
  }
  .iconbtn {
    width: var(--target);
    height: var(--target);
    flex: none;
    border-radius: 12px;
    border: 2px solid var(--ink-muted);
    background: #fff;
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
  }
  .iconbtn:disabled {
    border-color: var(--disabled-line);
    color: var(--disabled-ink);
    cursor: default;
  }
</style>
