<script lang="ts">
  /*
   * Create invite (flows §3.8), from the Invite board: the form, the
   * derivation wait for a passphrase invite, and the share screen, shown once.
   *
   * The share screen's link, words and QR come from the session's screen
   * state and nowhere else. This component keeps none of them: no input holds
   * the link, nothing is written to storage, the URL bar or history. The
   * passphrase has no copy button (decided in the prototype review): it is
   * spoken or written, never pasted beside the link. Closing the tab while
   * the share screen is up asks first, as leaving it in the app does.
   */
  import { copy, format, watermarkExample } from "$lib/copy/language.svelte";
  import { LABEL_MAX_CODE_POINTS, type InviteMode, type InviteScreen } from "$lib/owner/invite";
  import Alert from "$lib/ui/Alert.svelte";
  import DerivationWait from "$lib/ui/DerivationWait.svelte";
  import QrCode from "./QrCode.svelte";

  const t = $derived(copy());
  const fmt = $derived(format());

  let {
    invite,
    onBack,
    onMode,
    onLanguage,
    onRetryLanguages,
    onCreate,
    onAskLeave,
    onLeave,
  }: {
    invite: InviteScreen;
    onBack: () => void;
    onMode: (mode: InviteMode) => void;
    onLanguage: (language: string) => void;
    onRetryLanguages: () => void;
    onCreate: (label: string) => void;
    onAskLeave: (open: boolean) => void;
    onLeave: () => void;
  } = $props();

  let label = $state("");
  let copied: "idle" | "ok" | "failed" = $state("idle");

  const share = $derived(invite.share);
  const busy = $derived(invite.step === "deriving" || invite.step === "creating");
  const languages = $derived(Array.isArray(invite.languages) ? invite.languages : null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  function submit(e: SubmitEvent): void {
    e.preventDefault();
    onCreate(label);
  }

  async function copyLink(link: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      copied = "ok";
    } catch {
      copied = "failed";
    }
  }

  async function shareLink(link: string): Promise<void> {
    try {
      // The full URL, fragment included: that is the invitation.
      await navigator.share({ url: link });
    } catch {
      // Dismissed, or refused: the copy button is still there.
    }
  }

  function beforeUnload(e: BeforeUnloadEvent): void {
    if (invite.step !== "share") return;
    e.preventDefault();
    e.returnValue = "";
  }

  function problemText(p: InviteScreen["problem"]): string | null {
    switch (p) {
      case "label-empty":
        return t["invite.name.empty"];
      case "label-too-long":
        return t["invite.name.too-long"];
      case "no-language":
        return t["invite.language.choose"];
      case "failed":
        return t["invite.failed"];
      case "device":
        return t["invite.device"];
      default:
        return null;
    }
  }
</script>

<svelte:window onbeforeunload={beforeUnload} />

{#if invite.step === "deriving"}
  <main class="screen centred">
    <DerivationWait layout="stacked" />
  </main>
{:else if invite.step === "share" && share !== null}
  <main class="screen share" inert={invite.leaving}>
    <h1>{t["invite.share.title"](share.label)}</h1>

    {#if share.kind === "qr"}
      <QrCode text={share.link} label={t["invite.qr.a11y"](share.label)} />
      <p class="housekey">{t["invite.housekey"]}</p>
    {:else}
      <p class="channels">{t["invite.channels"]}</p>
    {/if}

    <section class="link" aria-labelledby="invite-link-label">
      <h2 id="invite-link-label">{t["invite.link.label"]}</h2>
      <p class="url" data-invite-link>{share.link}</p>
      <div class="actions">
        {#if canShare}
          <button class="btn" type="button" onclick={() => shareLink(share.link)}>{t["invite.link.share"]}</button>
        {/if}
        <button class="btn" class:ghost={canShare} type="button" onclick={() => copyLink(share.link)}>{t["invite.link.copy"]}</button>
      </div>
      {#if copied === "ok"}
        <p class="note" role="status">{t["invite.link.copied"]}</p>
      {:else if copied === "failed"}
        <Alert text={t["invite.link.copy-failed"]} />
      {/if}
      {#if share.kind === "passphrase"}
        <p class="housekey">{t["invite.housekey.passphrase"]}</p>
      {/if}
    </section>

    {#if share.kind === "passphrase"}
      <section class="words" aria-labelledby="invite-words-label">
        <h2 id="invite-words-label">{t["invite.passphrase.label"]}</h2>
        <!-- Shown to be read out or written down. Deliberately no copy button. -->
        <ol data-passphrase>
          {#each share.words as word, i (i)}
            <li>{word}</li>
          {/each}
        </ol>
        <p class="note">{t["invite.passphrase.language"](fmt.languageName(share.language))}</p>
      </section>
    {/if}

    <p class="once">{t["invite.once"]}</p>

    <div class="bottom">
      <button class="btn" type="button" onclick={() => onAskLeave(true)}>{t["invite.done"]}</button>
    </div>
  </main>

  {#if invite.leaving}
    <div class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="invite-leave-title" aria-describedby="invite-leave-text">
      <h2 id="invite-leave-title">{t["invite.leave.title"]}</h2>
      <p id="invite-leave-text">{t["invite.leave.consequence"]}</p>
      <button class="btn" type="button" onclick={() => onAskLeave(false)}>{t["invite.leave.stay"]}</button>
      <button class="btn ghost" type="button" onclick={onLeave}>{t["invite.leave.confirm"]}</button>
    </div>
  {/if}
{:else}
  <main class="screen invite">
    <div class="top">
      <button class="btn ghost back" type="button" disabled={busy} onclick={onBack}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
          ><path d="M15 5l-7 7 7 7"></path></svg
        >
        <span>{t["invite.back"]}</span>
      </button>
    </div>
    <h1>{t["invite.title"]}</h1>

    <form onsubmit={submit} novalidate>
      <fieldset class="group" disabled={busy}>
        <label for="invite-name">{t["invite.name.label"]}</label>
        <input
          id="invite-name"
          class="field"
          class:invalid={invite.problem === "label-empty" || invite.problem === "label-too-long"}
          type="text"
          autocomplete="off"
          maxlength={LABEL_MAX_CODE_POINTS * 2}
          aria-describedby="invite-name-hint"
          bind:value={label}
        />
        <p id="invite-name-hint" class="note">{t["invite.name.hint"](watermarkExample())}</p>
      </fieldset>

      <fieldset class="group modes" disabled={busy}>
        <legend>{t["invite.mode"]}</legend>
        <label class="opt" class:on={invite.mode === "qr"}>
          <input type="radio" name="invite-mode" value="qr" checked={invite.mode === "qr"} onchange={() => onMode("qr")} />
          <span class="opt-text">
            <span class="opt-name">{t["invite.mode.qr"]}</span>
            <span>{t["invite.mode.qr.detail"]}</span>
          </span>
        </label>
        <label class="opt" class:on={invite.mode === "passphrase"}>
          <input type="radio" name="invite-mode" value="passphrase" checked={invite.mode === "passphrase"} onchange={() => onMode("passphrase")} />
          <span class="opt-text">
            <span class="opt-name">{t["invite.mode.passphrase"]}</span>
            <span>{t["invite.mode.passphrase.detail"]}</span>
          </span>
        </label>
      </fieldset>

      {#if invite.mode === "passphrase"}
        <fieldset class="group" disabled={busy}>
          {#if invite.languages === "loading" || invite.languages === "idle"}
            <p class="note" role="status">{t["invite.language.loading"]}</p>
          {:else if invite.languages === "failed"}
            <Alert text={t["invite.language.failed"]} />
            <button class="btn ghost" type="button" onclick={onRetryLanguages}>{t["invite.language.retry"]}</button>
          {:else if languages !== null && languages.length === 0}
            <p class="note" role="status">{t["invite.language.none"]}</p>
          {:else if languages !== null}
            <label for="invite-language">{t["invite.language"]}</label>
            <select id="invite-language" class="field" aria-describedby="invite-language-hint" value={invite.language ?? ""} onchange={(e) => onLanguage(e.currentTarget.value)}>
              {#each languages as code (code)}
                <option value={code}>{fmt.languageLabel(code)}</option>
              {/each}
            </select>
            <p id="invite-language-hint" class="note">{t["invite.language.hint"]}</p>
          {/if}
        </fieldset>
      {/if}

      {#if problemText(invite.problem) !== null}
        <Alert text={problemText(invite.problem) ?? ""} />
      {/if}

      {#if invite.step === "creating"}
        <p class="note" role="status">{t["invite.creating"]}</p>
      {:else}
        <button class="btn" type="submit" disabled={invite.mode === "passphrase" && (languages === null || languages.length === 0)}>{t["invite.create"]}</button>
      {/if}
    </form>
  </main>
{/if}

<style>
  .invite,
  .share {
    padding-top: 12px;
  }
  .share {
    padding-top: 36px;
    gap: 22px;
  }
  .top {
    display: flex;
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 24px;
  }
  .group {
    border: 0;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
  }
  legend {
    padding: 0;
    margin-bottom: 12px;
    font-weight: 700;
  }
  label {
    font-weight: 700;
  }
  .opt {
    display: flex;
    gap: 14px;
    align-items: flex-start;
    border-radius: 16px;
    background: #fff;
    padding: 18px 16px;
    border: 3px solid var(--disabled-ink);
    cursor: pointer;
    font-weight: 400;
  }
  .opt.on {
    border-color: var(--accent);
  }
  .opt:focus-within {
    outline: 3px solid var(--focus);
    outline-offset: 3px;
  }
  .opt input {
    width: 28px;
    height: 28px;
    margin: 2px 0 0;
    accent-color: var(--accent);
    flex: none;
  }
  .opt-text {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .opt-name {
    font-weight: 700;
    font-size: var(--text-lead);
  }
  h2 {
    margin: 0;
    font-size: 20px;
  }
  .housekey,
  .channels {
    margin: 0;
    padding: 14px 16px;
    border-radius: var(--radius);
    background: var(--accent-soft);
    border: 2px solid var(--accent);
    font-weight: 700;
  }
  .link,
  .words {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .url {
    margin: 0;
    padding: 12px;
    border: 2px solid var(--ink-muted);
    border-radius: 12px;
    background: #fff;
    font-size: 15px;
    line-height: 1.35;
    overflow-wrap: anywhere;
    user-select: all;
    -webkit-user-select: all;
  }
  .actions {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .actions .btn.ghost {
    width: 100%;
  }
  ol {
    margin: 0;
    padding-left: 1.6em;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 24px;
    font-size: 24px;
    font-weight: 700;
  }
  .once {
    margin: 0;
  }
  .sheet {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    max-width: 616px;
    margin: 0 auto;
    background: #fff;
    border: 2px solid var(--ink);
    border-radius: var(--radius);
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .sheet h2 {
    font-size: 24px;
  }
  .sheet p {
    margin: 0;
  }
  .sheet .btn.ghost {
    width: 100%;
  }
</style>
