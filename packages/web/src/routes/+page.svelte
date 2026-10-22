<script lang="ts">
  /*
   * The owner path's composition point. This is the one place the owner's eight
   * key functions (lib/keys/owner-open.ts) meet the session. Tests build the
   * same session with fakes of all eight.
   */
  import { onMount } from "svelte";
  import { api } from "$lib/api";
  import { en } from "$lib/copy/en";
  import * as ownerKeys from "$lib/keys/owner-open";
  import { OwnerSession, type State } from "$lib/owner/session";
  import { browserImaging } from "$lib/owner/imaging";
  import Album from "$lib/owner/ui/Album.svelte";
  import AccessLog from "$lib/owner/ui/AccessLog.svelte";
  import Albums from "$lib/owner/ui/Albums.svelte";
  import Invite from "$lib/owner/ui/Invite.svelte";
  import People from "$lib/owner/ui/People.svelte";
  import SignIn from "$lib/owner/ui/SignIn.svelte";
  import SignUp from "$lib/owner/ui/SignUp.svelte";
  import Unlock from "$lib/owner/ui/Unlock.svelte";
  import Message from "$lib/recipient/ui/Message.svelte";
  import { sessionStore } from "$lib/session/owner-session";
  import type { LayoutData } from "./$types";

  let { data }: { data: LayoutData } = $props();

  let ui = $state.raw<State>({ screen: { kind: "checking" }, offline: false, rateLimited: false, expiry: null });
  let session: OwnerSession | undefined;

  const twoFrames = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  onMount(() => {
    if (data.envelope.status !== "ready") return;
    const { envelope, poison } = data.envelope.loaded;
    const s = new OwnerSession({
      client: api,
      envelope,
      poison,
      keys: {
        createAccountKeys: ownerKeys.createAccountKeys,
        deriveLoginCredential: ownerKeys.deriveLoginCredential,
        openMasterKey: ownerKeys.openMasterKey,
        unlockMasterKey: ownerKeys.unlockMasterKey,
        openAlbumKey: ownerKeys.openAlbumKey,
        createAlbumKey: ownerKeys.createAlbumKey,
        createQrInvite: ownerKeys.createQrInvite,
        createPassphraseInvite: ownerKeys.createPassphraseInvite,
      },
      store: sessionStore(),
      // Bundled, not fetched (connect-src names the API alone), and a chunk of
      // its own so only signup ever loads it. check-build.mjs enforces both.
      loadBlocklist: () => import("$lib/owner/blocklist").then((m) => m.BLOCKLIST),
      newAlbumId: () => crypto.randomUUID(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      nextFrames: twoFrames,
      now: () => new Date(),
      setTimer: (ms, fn) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
      imaging: browserImaging,
      // Bytes straight to a bitmap: no object URL is ever created for a decrypted image.
      decodeImage: (bytes) => createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>])),
      newMediaId: () => crypto.randomUUID(),
      // Bundled, a chunk of its own, loaded only when passphrase mode is chosen. check-build.mjs enforces it.
      loadWordlists: () => import("$lib/owner/wordlists").then((m) => m.WORDLISTS),
      // The interface is English only for now (brief §15.3); the passphrase language defaults to it when a list exists.
      displayLanguage: "en",
      origin: location.origin,
    });
    session = s;
    const unsubscribe = s.subscribe((next) => (ui = next));
    const online = (): void => s.retryOffline();
    window.addEventListener("online", online);
    s.start();
    return () => {
      window.removeEventListener("online", online);
      unsubscribe();
      s.dispose();
    };
  });

  const screen = $derived(ui.screen);
</script>

<svelte:head>
  <title>Vitrina</title>
</svelte:head>

{#if screen.kind === "checking"}
  <Message text={en["owner.checking"]} role="status" />
{:else if screen.kind === "signin"}
  {#key screen.email}
    <SignIn
      phase={screen.phase}
      notice={screen.notice}
      initialEmail={screen.email}
      pausedUntil={screen.pausedUntil}
      onSubmit={(email, password) => session?.submitSignin(email, password)}
      onRetry={(email) => session?.backToSignin(email)}
      onSignup={() => session?.enterSignup()}
    />
  {/key}
{:else if screen.kind === "signup"}
  <SignUp
    phase={screen.phase}
    pausedUntil={screen.pausedUntil}
    onSubmit={(email, password) => session?.submitSignup(email, password)}
    onSignin={(email) => session?.backToSignin(email)}
  />
{:else if screen.kind === "signup-uncertain"}
  <main class="screen" role="alert">
    <h1>{en["signup.uncertain"]}</h1>
    <div class="bottom">
      <button class="btn" type="button" onclick={() => session?.backToSignin(screen.email)}>{en["signup.uncertain.signin"]}</button>
    </div>
  </main>
{:else if screen.kind === "unlock"}
  <Unlock
    phase={screen.phase}
    signingOut={screen.signingOut}
    onSubmit={(password) => session?.submitUnlock(password)}
    onRetry={() => session?.retryUnlock()}
    onAskSignOut={(open) => session?.askUnlockSignOut(open)}
    onSignOut={() => session?.logout("device")}
  />
{:else if screen.kind === "cannot-unlock"}
  <main class="screen" role="alert">
    <h1>{en["signin.cannot-unlock"]}</h1>
    <div class="bottom">
      <button class="btn" type="button" onclick={() => session?.backToSignin()}>{en["signin.back"]}</button>
    </div>
  </main>
{:else if screen.kind === "device-failed"}
  <!-- Flows §2's third exit. Never a wrong password. A trapped instance is unusable, so the remedy is a reload. -->
  <main class="screen" role="alert">
    <h1>{en["derive.failed.owner"]}</h1>
    <div class="bottom">
      <button class="btn" type="button" onclick={() => location.reload()}>{en["derive.failed.retry"]}</button>
    </div>
  </main>
{:else if screen.kind === "albums"}
  <Albums
    phase={screen.phase}
    albums={screen.albums}
    create={screen.create}
    signingOut={screen.signingOut}
    expiry={ui.expiry}
    onOpenCreate={() => session?.openCreate()}
    onCloseCreate={() => session?.closeCreate()}
    onCreate={(title) => session?.createAlbum(title)}
    onLogout={(scope) => session?.logout(scope)}
    onOpen={(id) => session?.openAlbum(id)}
  />
{:else if screen.kind === "album"}
  <Album
    album={screen}
    expiry={ui.expiry}
    onBack={() => session?.leaveAlbum()}
    onLeave={() => session?.leaveAlbum(true)}
    onStay={() => session?.stayInAlbum()}
    onAdd={(files) => session?.addPhotos(files)}
    onOpen={(key) => session?.openViewer(key)}
    onCloseViewer={() => session?.closeViewer()}
    onRetryThumb={(key) => session?.retryThumb(key)}
    onResend={(key) => session?.resendPhoto(key)}
    onDismiss={(key) => session?.dismissPhoto(key)}
    onRemove={(key) => session?.askRemove(key)}
    onCancelRemove={() => session?.cancelRemove()}
    onConfirmRemove={() => session?.confirmRemove()}
    onInvite={() => session?.openInvite()}
    onPeople={() => session?.openPeople()}
  />
{:else if screen.kind === "invite"}
  <Invite
    invite={screen}
    onBack={() => session?.leaveInvite()}
    onMode={(mode) => session?.chooseInviteMode(mode)}
    onLanguage={(language) => session?.chooseInviteLanguage(language)}
    onRetryLanguages={() => session?.retryInviteLanguages()}
    onCreate={(label) => session?.createInvite(label)}
    onAskLeave={(open) => session?.askLeaveInvite(open)}
    onLeave={() => session?.leaveInvite(true)}
  />
{:else if screen.kind === "people"}
  <People
    people={screen}
    onBack={() => session?.leavePeople()}
    onRevoke={(id) => session?.askRevoke(id)}
    onCancelRevoke={() => session?.cancelRevoke()}
    onConfirmRevoke={() => session?.confirmRevoke()}
    onLog={(id) => session?.openLog(id)}
  />
{:else if screen.kind === "log"}
  <AccessLog log={screen} onBack={() => session?.closeLog()} onMore={() => session?.moreLog()} />
{:else if screen.kind === "signed-out-partial"}
  <main class="screen" role="alert">
    <h1>{en["logout.partial"](screen.scope === "everywhere")}</h1>
    <div class="bottom actions">
      <button class="btn" type="button" disabled={screen.retrying} onclick={() => session?.logout(screen.scope)}>{en["logout.retry"]}</button>
      <button class="btn ghost" type="button" disabled={screen.retrying} onclick={() => session?.leaveAfterPartial()}>{en["logout.leave"]}</button>
    </div>
  </main>
{/if}

{#if ui.rateLimited && !ui.offline}
  <!-- A token route's 429, waited out in place (flows §0). Credential routes pause their form instead. -->
  <div class="offline" role="status">
    <span>{en["wait.rate-limited"]}</span>
  </div>
{/if}

{#if ui.offline}
  <div class="offline" role="alert">
    <span>{en["offline.owner"]}</span>
    <button class="btn" type="button" onclick={() => session?.retryOffline()}>{en["offline.retry"]}</button>
  </div>
{/if}

<style>
  .actions {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .actions .btn.ghost {
    width: 100%;
  }
  .offline {
    position: fixed;
    left: 12px;
    right: 12px;
    bottom: 12px;
    z-index: 2;
    max-width: 616px;
    margin: 0 auto;
    background: var(--ink);
    color: #fff;
    border-radius: var(--radius);
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
</style>
