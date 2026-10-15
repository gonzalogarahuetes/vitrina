/*
 * The recipient path as one state machine: flows §1.2's key states and §4's
 * screens. Plain TypeScript so the whole path runs under test with a recording
 * fetch, a fake envelope and fakes of the owner's two functions.
 *
 * What changes key state, and nothing else does:
 *   - 403 ACCESS_REVOKED, anywhere → revoked: K_album freed, every decrypted
 *     image closed, title and label dropped.
 *   - recipient 401 (and 404 from /recipient/key) → not recognised, the same.
 *   - a WASM trap → device failed, the same minus free(): the instance is
 *     poisoned and is not touched again (envelope.ts).
 * A network failure is an offline state that frees, clears and closes nothing
 * (flows §0); 429 waits for Retry-After.
 */
import { ApiFailure, NetworkFailure, UnexpectedResponse, type ApiClient } from "$lib/api/client";
import { en, watermarkDate } from "$lib/copy/en";
import { EnvelopeUnavailable, type Envelope, type Poison } from "$lib/envelope";
import { uuidFromBytes, uuidToBytes } from "$lib/ids";
import type { ParseInvite } from "$lib/invite/types";
import type { AlbumKey, OpenDirectKey, OpenPassphraseKey, RecipientKeyMaterial } from "$lib/keys/types";
import { decodeBase64urlRange } from "@vitrina/shared";
import { recipientApi, type AlbumDetails, type RecipientApi } from "./api";
import type { Picture } from "./render";

export type Thumb =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly picture: Picture }
  /** The thumbnail could not be fetched or opened: retryable from its cell. */
  | { readonly kind: "failed" }
  /** Its metadata is missing or invalid: this one cell fails, for good, and nothing is fetched for it. */
  | { readonly kind: "unavailable" };

export type Item = { readonly id: string; readonly thumb: Thumb; readonly size: { readonly w: number; readonly h: number } | null };

export type Viewer = {
  readonly index: number;
  readonly id: string;
  readonly phase: "loading" | "shown" | "removed" | "failed";
  /** The full photo, once decoded. Closed when the viewer leaves. */
  readonly picture: Picture | null;
};

export type PassphrasePhase = "loading" | "ready" | "empty" | "wrong" | "deriving";

export type Screen =
  | { readonly kind: "starting" }
  | { readonly kind: "dead" }
  | { readonly kind: "newer-version" }
  | { readonly kind: "not-recognised" }
  | { readonly kind: "revoked" }
  | { readonly kind: "device-failed" }
  | { readonly kind: "passphrase"; readonly phase: PassphrasePhase }
  | { readonly kind: "onboarding" }
  | {
      readonly kind: "album";
      readonly phase: "loading" | "ready";
      readonly title: string;
      readonly watermark: readonly string[];
      readonly items: readonly Item[];
      readonly viewer: Viewer | null;
    };

export type State = { readonly screen: Screen; readonly offline: boolean };

export type Deps = {
  readonly client: ApiClient;
  readonly envelope: Envelope;
  readonly poison: Poison;
  readonly parseInvite: ParseInvite;
  readonly openDirectKey: OpenDirectKey;
  readonly openPassphraseKey: OpenPassphraseKey;
  /** createImageBitmap(new Blob([bytes])) in the browser: no URL is ever made. */
  readonly decodeImage: (bytes: Uint8Array) => Promise<Picture>;
  readonly sleep: (ms: number) => Promise<void>;
  /** Two animation frames, so the derivation-wait screen is painted before Argon2id blocks. */
  readonly nextFrames: () => Promise<void>;
  readonly now: () => Date;
};

/** Thrown through an in-flight operation once the session has reached a terminal screen. */
class Halted extends Error {
  override readonly name = "Halted";
}

const THUMB_CONCURRENCY = 4;
const DEFAULT_RETRY_AFTER_S = 5;

const decodeBlob = (b64: string) => decodeBase64urlRange(b64, 1, 64 * 1024 * 1024);

/*
 * The metadata JSON, as the owner decided it: `width` and `height` are required
 * positive integers, of the image as encrypted; `name` and `taken_at` are
 * optional; unknown fields are ignored; there is no `v`. Null means this one
 * item's metadata is unusable, which fails its cell and nothing else.
 */
const positiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

export function readSize(json: string): { w: number; h: number } | null {
  try {
    const v: unknown = JSON.parse(json);
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const { width, height } = v as { width?: unknown; height?: unknown };
    return positiveInt(width) && positiveInt(height) ? { w: width, h: height } : null;
  } catch {
    return null;
  }
}

/*
 * A server fault, not a key fault: a 5xx, or a response that is not the API's
 * (a proxy's error page, a body of the wrong shape). Retryable like a lost
 * connection; only 401 and 403 change key state (flows §0).
 */
const serverFault = (e: unknown): boolean =>
  (e instanceof ApiFailure && e.status >= 500) || e instanceof UnexpectedResponse;

export class RecipientSession {
  private state: State = { screen: { kind: "starting" }, offline: false };
  private readonly listeners = new Set<(s: State) => void>();

  // Key state. Nothing here is ever serialised or stored.
  private api: RecipientApi | null = null;
  private albumId: string | null = null;
  private albumIdBytes: Uint8Array | null = null;
  private albumKey: AlbumKey | null = null;
  private material: RecipientKeyMaterial | null = null;
  private details: Promise<AlbumDetails> | null = null;
  /** The decrypted label and today's date, as the watermark's two lines. Dropped with the key. */
  private watermark: readonly string[] = [];

  private halted = false;
  private online: { promise: Promise<void>; resolve: () => void } | null = null;
  private viewerGen = 0;
  private gridEntered = false;

  constructor(private readonly deps: Deps) {
    deps.poison.onPoison(() => this.terminal("device-failed"));
  }

  get current(): State {
    return this.state;
  }

  subscribe(listener: (s: State) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private set(screen: Screen): void {
    this.state = { ...this.state, screen };
    for (const l of this.listeners) l(this.state);
  }

  private setOffline(offline: boolean): void {
    if (this.state.offline === offline) return;
    this.state = { ...this.state, offline };
    for (const l of this.listeners) l(this.state);
  }

  private album(): Extract<Screen, { kind: "album" }> | null {
    return this.state.screen.kind === "album" ? this.state.screen : null;
  }

  // ── Terminal screens: the only places key state is dropped ─────────────────

  private dropKeyState(free: boolean): void {
    const key = this.albumKey;
    this.albumKey = null;
    if (key !== null && free) {
      try {
        key.free();
      } catch {
        // Poisoned or already freed: nothing more can be done from here.
      }
    }
    const a = this.album();
    if (a !== null) {
      for (const item of a.items) if (item.thumb.kind === "ready") item.thumb.picture.close();
      a.viewer?.picture?.close();
    }
    this.material = null;
    this.watermark = [];
    this.details = null;
    this.api = null;
    this.albumIdBytes = null;
    this.albumId = null;
  }

  private terminal(kind: "revoked" | "not-recognised" | "device-failed" | "dead" | "newer-version"): void {
    if (this.halted) return;
    this.halted = true;
    // A trapped instance must not be touched, so the handle is not freed.
    this.dropKeyState(kind !== "device-failed" && !this.deps.poison.poisoned);
    this.online?.resolve();
    this.online = null;
    this.state = { screen: { kind }, offline: false };
    for (const l of this.listeners) l(this.state);
  }

  /** Leaving the page: the same release as a terminal screen, without one. */
  dispose(): void {
    if (this.halted) return;
    this.halted = true;
    this.dropKeyState(!this.deps.poison.poisoned);
    this.listeners.clear();
  }

  // ── Every request goes through here ────────────────────────────────────────

  private async call<T>(op: (api: RecipientApi) => Promise<T>): Promise<T> {
    for (;;) {
      const api = this.api;
      if (this.halted || api === null) throw new Halted();
      try {
        const out = await op(api);
        if (this.halted) throw new Halted();
        return out;
      } catch (e) {
        if (this.halted || e instanceof Halted) throw new Halted();
        if (e instanceof NetworkFailure || serverFault(e)) {
          await this.waitOnline();
          continue;
        }
        if (e instanceof ApiFailure) {
          if (e.status === 429) {
            await this.deps.sleep((e.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000);
            continue;
          }
          if (e.status === 403 && e.code === "ACCESS_REVOKED") {
            this.terminal("revoked");
            throw new Halted();
          }
          if (e.status === 401) {
            this.terminal("not-recognised");
            throw new Halted();
          }
        }
        throw e;
      }
    }
  }

  /** Offline: show it, change nothing else, resume every waiting call on retry. */
  private waitOnline(): Promise<void> {
    if (this.online === null) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.online = { promise, resolve };
      this.setOffline(true);
    }
    return this.online.promise;
  }

  retryOffline(): void {
    const o = this.online;
    this.online = null;
    this.setOffline(false);
    o?.resolve();
  }

  private guarded(task: () => Promise<void>): void {
    task().catch((e: unknown) => {
      if (e instanceof Halted) return;
      if (e instanceof EnvelopeUnavailable || this.deps.poison.poisoned) return this.terminal("device-failed");
      // Anything else unanticipated is not evidence that the key is lost, so
      // it is not the dead page and it changes no key state: show the
      // retryable state and run the same step again on retry.
      void this.waitOnline().then(() => {
        if (!this.halted) this.guarded(task);
      });
    });
  }

  // ── §4.1 Open link ─────────────────────────────────────────────────────────

  /**
   * `fragment` was read and stripped from the address bar by the caller
   * (entry.ts) before this runs; nothing here has made a request yet.
   */
  start(fragment: string): void {
    const parsed = this.deps.parseInvite(fragment);
    if (!parsed.ok) {
      return this.terminal(parsed.error.kind === "unsupported-version" ? "newer-version" : "dead");
    }
    const invite = parsed.invite;
    this.albumIdBytes = invite.albumId;
    this.albumId = uuidFromBytes(invite.albumId);
    this.api = recipientApi(this.deps.client, invite.token);

    if (invite.mode === "qr") {
      // openDirectKey zeroes invite.key, which makes the Invite object dead:
      // nothing may keep `invite` (or `parsed`) past this line.
      const opened = this.deps.openDirectKey(this.deps.envelope, invite.key);
      if (!opened.ok) return this.terminal("device-failed");
      this.albumKey = opened.albumKey;
      this.guarded(() => this.enterOnboarding());
    } else {
      this.set({ kind: "passphrase", phase: "loading" });
      this.guarded(() => this.fetchKeyMaterial());
    }
  }

  // ── §4.2 Enter passphrase ──────────────────────────────────────────────────

  private async fetchKeyMaterial(): Promise<void> {
    try {
      this.material = await this.call((api) => api.key());
    } catch (e) {
      // A QR row's token on a passphrase-shaped link (api-sketch §10.1).
      if (e instanceof ApiFailure && e.status === 404) return this.terminal("not-recognised");
      throw e;
    }
    this.set({ kind: "passphrase", phase: "ready" });
  }

  /** The words as typed, joined; normalisation is the crate's (encryption spec §6.3). */
  submitPassphrase(words: readonly string[]): void {
    const s = this.state.screen;
    if (s.kind !== "passphrase" || s.phase === "loading" || s.phase === "deriving") return;
    const material = this.material;
    if (material === null) return;
    const passphrase = words.join(" ");
    // A cheap pre-check so an empty entry never shows the wait; the crate's
    // EmptyPassphrase is the exact rule and is still mapped below.
    if (passphrase.trim() === "") return this.set({ kind: "passphrase", phase: "empty" });

    this.set({ kind: "passphrase", phase: "deriving" });
    this.guarded(async () => {
      await this.deps.nextFrames();
      const result = await this.deps.openPassphraseKey(this.deps.envelope, passphrase, material);
      if (this.halted) {
        if (result.ok) result.albumKey.free();
        return;
      }
      if (result.ok) {
        this.albumKey = result.albumKey;
        this.material = null;
        return this.enterOnboarding();
      }
      switch (result.error) {
        case "empty":
          return this.set({ kind: "passphrase", phase: "empty" });
        case "wrong-passphrase":
          return this.set({ kind: "passphrase", phase: "wrong" });
        case "could-not-derive":
          // Terminal for the tab, whatever the cause: never shown as a wrong passphrase.
          return this.terminal("device-failed");
        case "unusable-material":
          return this.terminal("not-recognised");
      }
    });
  }

  // ── §4.1 step 5, §4.3 Onboarding ───────────────────────────────────────────

  private async enterOnboarding(): Promise<void> {
    const key = this.albumKey;
    if (key === null) throw new Halted();
    const row = await this.call((api) => api.recipient());
    // The token's album must be the link's album; anything else is a damaged link.
    if (row.album_id !== this.albumId) return this.terminal("dead");
    // Decoded outside the try: a malformed field is the server's fault, retryable, not a damaged link.
    const labelBlob = decodeBlob(row.label);
    let label: string;
    try {
      label = this.deps.envelope.decryptRecipientLabel(key, uuidToBytes(row.id), labelBlob);
    } catch (e) {
      if (e instanceof EnvelopeUnavailable) throw e;
      // Under a QR link's key this means the key is not this album's.
      return this.terminal("dead");
    }
    this.watermark = en.watermark(label, watermarkDate(this.deps.now()));
    // §9.4 writes no log and may run during onboarding. §9.5 waits for the grid.
    const albumId = this.albumId;
    if (albumId === null) throw new Halted();
    this.details = this.call((api) => api.album(albumId));
    this.details.catch(() => undefined); // awaited, and its failure handled, on entering the grid
    this.set({ kind: "onboarding" });
  }

  // ── §4.4 Grid ──────────────────────────────────────────────────────────────

  /** Onboarding's continue. The grid is on screen from here, so the open is logged from here. */
  enterGrid(): void {
    if (this.state.screen.kind !== "onboarding" || this.gridEntered) return;
    this.gridEntered = true;
    this.set({ kind: "album", phase: "loading", title: "", watermark: this.watermark, items: [], viewer: null });
    this.guarded(() => this.loadGrid());
  }

  private async loadGrid(): Promise<void> {
    const key = this.albumKey;
    const albumId = this.albumId;
    const albumIdBytes = this.albumIdBytes;
    if (key === null || albumId === null || albumIdBytes === null) throw new Halted();

    // Network loss, 5xx and 429 are retried inside call(); what reaches here is final.
    // The onboarding-time fetch is used once: a retried step fetches afresh.
    const detailsP = this.details ?? this.call((api) => api.album(albumId));
    this.details = null;
    const [details, metadata] = await Promise.all([
      detailsP,
      this.call((api) => api.metadata(albumId)),
    ]).catch((e: unknown) => {
      if (e instanceof ApiFailure && e.status === 404) {
        this.terminal("dead");
        throw new Halted();
      }
      throw e;
    });

    const titleBlob = decodeBlob(details.title);
    let title: string;
    try {
      title = this.deps.envelope.decryptAlbumTitle(key, albumIdBytes, titleBlob);
    } catch (e) {
      if (e instanceof EnvelopeUnavailable) throw e;
      return this.terminal("dead"); // flows §4.4: a damaged link
    }

    const envelopes = new Map(metadata.metadata.map((m) => [m.media_id, m.envelope]));
    // Hide anything that is not `ready` (api-sketch §9.4).
    const items: Item[] = details.media
      .filter((m) => m.status === "ready")
      .map((m) => {
        let size: Item["size"] = null;
        const env = envelopes.get(m.id);
        if (env !== undefined) {
          try {
            const plain = this.deps.envelope.decryptMeta(key, uuidToBytes(m.id), decodeBlob(env));
            size = readSize(new TextDecoder().decode(plain));
          } catch (e) {
            if (e instanceof EnvelopeUnavailable) throw e;
          }
        }
        const thumb: Thumb = size === null ? { kind: "unavailable" } : { kind: "loading" };
        return { id: m.id, thumb, size };
      });

    this.set({ kind: "album", phase: "ready", title, watermark: this.watermark, items, viewer: null });
    this.loadThumbnails(items.filter((i) => i.thumb.kind === "loading").map((i) => i.id));
  }

  private updateItem(id: string, thumb: Thumb): boolean {
    const a = this.album();
    if (a === null || !a.items.some((i) => i.id === id)) return false;
    this.set({ ...a, items: a.items.map((i) => (i.id === id ? { ...i, thumb } : i)) });
    return true;
  }

  /** Thumbnails may be fetched freely: they never log (api-sketch §11.6). */
  private loadThumbnails(ids: readonly string[]): void {
    const queue = [...ids];
    const worker = async (): Promise<void> => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) await this.loadThumb(id);
    };
    for (let i = 0; i < Math.min(THUMB_CONCURRENCY, queue.length); i++) this.guarded(worker);
  }

  private async loadThumb(id: string): Promise<void> {
    const key = this.albumKey;
    if (key === null) throw new Halted();
    let picture: Picture;
    try {
      const object = await this.call((api) => api.thumbnail(id));
      const plain = this.deps.envelope.decryptThumb(key, uuidToBytes(id), object);
      try {
        picture = await this.deps.decodeImage(plain);
      } finally {
        plain.fill(0);
      }
    } catch (e) {
      if (e instanceof Halted || e instanceof EnvelopeUnavailable) throw e;
      this.updateItem(id, { kind: "failed" });
      return;
    }
    if (this.halted || !this.updateItem(id, { kind: "ready", picture })) picture.close();
  }

  retryThumb(id: string): void {
    const a = this.album();
    const item = a?.items.find((i) => i.id === id);
    if (item?.thumb.kind !== "failed") return;
    this.updateItem(id, { kind: "loading" });
    this.guarded(() => this.loadThumb(id));
  }

  // ── §4.5 Viewer ────────────────────────────────────────────────────────────

  /** The full asset is fetched here, for this photo only, never for its neighbours. */
  openViewer(index: number): void {
    const a = this.album();
    const item = a?.items[index];
    if (a === null || item === undefined || a.viewer !== null || item.size === null) return;
    const gen = ++this.viewerGen;
    this.set({ ...a, viewer: { index, id: item.id, phase: "loading", picture: null } });
    this.guarded(() => this.loadAsset(gen, item.id));
  }

  private setViewer(gen: number, v: Omit<Viewer, "index" | "id">): boolean {
    const a = this.album();
    if (a?.viewer === null || a === null || gen !== this.viewerGen) return false;
    this.set({ ...a, viewer: { ...a.viewer, ...v } });
    return true;
  }

  private async loadAsset(gen: number, id: string): Promise<void> {
    const key = this.albumKey;
    if (key === null) throw new Halted();
    let object: Uint8Array<ArrayBuffer>;
    try {
      object = await this.call((api) => api.asset(id));
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) {
        this.setViewer(gen, { phase: "removed", picture: null });
        return;
      }
      if (e instanceof Halted) throw e;
      this.setViewer(gen, { phase: "failed", picture: null });
      return;
    }
    if (gen !== this.viewerGen) return;
    let picture: Picture;
    try {
      const plain = this.deps.envelope.decryptAsset(key, uuidToBytes(id), object);
      try {
        picture = await this.deps.decodeImage(plain);
      } finally {
        plain.fill(0);
      }
    } catch (e) {
      if (e instanceof EnvelopeUnavailable) throw e;
      // Decryption failed, or the device could not decode it (brief §11, memory).
      this.setViewer(gen, { phase: "failed", picture: null });
      return;
    }
    if (this.halted || !this.setViewer(gen, { phase: "shown", picture })) picture.close();
  }

  closeViewer(): void {
    const a = this.album();
    if (a?.viewer === null || a === null) return;
    this.viewerGen++;
    a.viewer.picture?.close();
    this.set({ ...a, viewer: null });
  }
}
