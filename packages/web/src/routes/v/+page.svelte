<script lang="ts">
  /*
   * The recipient path's composition point: the one place the owner's two
   * functions (lib/invite/parse.ts, lib/keys/open.ts) meet the session. Tests
   * build the same session with fakes of both.
   */
  import { onMount } from "svelte";
  import { api } from "$lib/api";
  import { en } from "$lib/copy/en";
  import { parseInvite } from "$lib/invite/parse";
  import { openDirectKey, openPassphraseKey } from "$lib/keys/open";
  import { takeCapturedInvite } from "$lib/recipient/entry";
  import { RecipientSession, type State } from "$lib/recipient/session";
  import Grid from "$lib/recipient/ui/Grid.svelte";
  import Message from "$lib/recipient/ui/Message.svelte";
  import Onboarding from "$lib/recipient/ui/Onboarding.svelte";
  import Passphrase from "$lib/recipient/ui/Passphrase.svelte";
  import Viewer from "$lib/recipient/ui/Viewer.svelte";
  import type { LayoutData } from "../$types";

  let { data }: { data: LayoutData } = $props();

  // Raw: the session replaces the state whole and owns its pictures; nothing here proxies them.
  let ui = $state.raw<State>({ screen: { kind: "starting" }, offline: false });
  let session: RecipientSession | undefined;
  let album: HTMLDivElement | undefined = $state();

  const twoFrames = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

  onMount(() => {
    // hooks.client.ts took the fragment and stripped it before the router
    // started; nothing has made a request yet.
    const fragment = takeCapturedInvite();
    if (data.envelope.status !== "ready") return;
    const { envelope, poison } = data.envelope.loaded;
    const s = new RecipientSession({
      client: api,
      envelope,
      poison,
      parseInvite,
      openDirectKey,
      openPassphraseKey,
      // Bytes straight to a bitmap: no object URL is ever created, so none can outlive the draw.
      decodeImage: (bytes) => createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>])),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      nextFrames: twoFrames,
      now: () => new Date(),
    });
    session = s;
    const unsubscribe = s.subscribe((next) => (ui = next));
    const online = (): void => s.retryOffline();
    window.addEventListener("online", online);
    s.start(fragment);
    return () => {
      window.removeEventListener("online", online);
      unsubscribe();
      s.dispose();
    };
  });

  // Brief §10's friction layer, on the grid and the viewer: no context menu,
  // no drag, no selection. Bypassable by design; it defeats accidents.
  $effect(() => {
    const el = album;
    if (el === undefined) return;
    const stop = (e: Event): void => e.preventDefault();
    const kinds = ["contextmenu", "dragstart", "selectstart"] as const;
    for (const k of kinds) el.addEventListener(k, stop);
    return () => {
      for (const k of kinds) el.removeEventListener(k, stop);
    };
  });

  const screen = $derived(ui.screen);
</script>

<svelte:head>
  <title>Vitrina</title>
</svelte:head>

{#if screen.kind === "starting"}
  <Message text={en["open.loading"]} role="status" />
{:else if screen.kind === "dead"}
  <Message text={en.dead} />
{:else if screen.kind === "newer-version"}
  <Message text={en["open.newer-version"]} />
{:else if screen.kind === "not-recognised"}
  <Message text={en.notrecognised} />
{:else if screen.kind === "revoked"}
  <Message text={en.revoked} kind="closed" />
{:else if screen.kind === "device-failed"}
  <Message text={en["derive.failed"]} kind="device" />
{:else if screen.kind === "passphrase"}
  <Passphrase phase={screen.phase} onSubmit={(words) => session?.submitPassphrase(words)} />
{:else if screen.kind === "onboarding"}
  <Onboarding onContinue={() => session?.enterGrid()} />
{:else if screen.kind === "album"}
  <div class="album" bind:this={album}>
    <div inert={screen.viewer !== null}>
      <Grid
      title={screen.title}
      loading={screen.phase === "loading"}
      items={screen.items}
      watermark={screen.watermark}
      onOpen={(i) => session?.openViewer(i)}
      onRetry={(id) => session?.retryThumb(id)}
      />
    </div>
    {#if screen.viewer !== null}
      {@const item = screen.items[screen.viewer.index]}
      <Viewer
        viewer={screen.viewer}
        standIn={item?.thumb.kind === "ready" ? item.thumb.picture : null}
        count={screen.items.length}
        watermark={screen.watermark}
        onClose={() => session?.closeViewer()}
      />
    {/if}
  </div>
{/if}

{#if ui.offline}
  <div class="offline" role="alert">
    <span>{en.offline}</span>
    <button class="btn" type="button" onclick={() => session?.retryOffline()}>{en["offline.retry"]}</button>
  </div>
{/if}

<style>
  .album {
    -webkit-user-select: none;
    user-select: none;
    -webkit-touch-callout: none;
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
