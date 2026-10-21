/*
 * The owner's album (flows §3.4), upload (§3.6) and removal (§3.7), as a part
 * of the owner session. OwnerSession owns key state and every request's
 * failure handling (401, offline, 429); this owns what one open album shows.
 * It is created when the owner opens an album and disposed when they leave
 * it, sign out, or the session ends, and from then on nothing it started
 * continues: every await re-checks, and a stopped operation throws.
 *
 * Rules this file is the enforcement of:
 *   - Every item is drawn in its server state. Only the server's `ready`
 *     makes an item done (#9, api-sketch §9.7), never this device's evidence.
 *   - One photo at a time, from decode to `ready` (brief §11, memory).
 *   - A `409` on create is our own lost response: same id, never a new one.
 *   - Requests on the upload path are paced under §11.5's 300 a minute.
 *   - The filename is in the metadata envelope and nowhere else. It is shown
 *     on this screen for local items only, and never sent.
 *   - Full assets are fetched only when the viewer shows one.
 *   - Removal's confirmation is computed from `created_at` and the access
 *     log, never assumed (flows §3.7).
 */
import { ApiFailure } from "$lib/api/client";
import { EnvelopeUnavailable, type Envelope } from "$lib/envelope";
import { uuidToBytes } from "$lib/ids";
import type { AlbumKey } from "$lib/keys/owner-types";
import type { MediaStatus } from "$lib/recipient/api";
import type { Picture } from "$lib/recipient/render";
import { readSize, type Viewer } from "$lib/recipient/session";
import { decodeBase64urlRange } from "@vitrina/shared";
import type { MediaStatusBody, OwnerApi } from "./api";
import { prepare, type Imaging, type PrepareError } from "./prepare";

// ── What the screen shows ──────────────────────────────────────────────────

export type LocalStep =
  /** Chosen, waiting for the photo before it to finish. */
  | "queued"
  /** Decoding, orienting, downscaling, re-encoding, scanning (flows §3.6 step 1). */
  | "preparing"
  | "encrypting"
  /** POST, then the two PUTs. */
  | "uploading"
  /** Sent; waiting for the server's `ready`. */
  | "waiting";

/** Why an item failed on this device before anything about it was sent. */
export type LocalFailure = PrepareError | "not-encrypted" | "refused";

export type OwnerThumb =
  /** Not `ready`: there is nothing to fetch. */
  | { readonly kind: "none" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly picture: Picture }
  | { readonly kind: "failed" }
  /** Its metadata will not open: this cell can never show the photo. */
  | { readonly kind: "unavailable" };

export type MediaItem = {
  /** Stable for the item's life on this screen: the media id, or `local-N` for one this device is adding. */
  readonly key: string;
  readonly id: string | null;
  /** The server's word. Null until the row exists. */
  readonly status: MediaStatus | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  /** `pending` or `processing` with an old `updated_at`, and nothing on this device moving it. */
  readonly stalled: boolean;
  readonly local: LocalStep | null;
  /** Failed on this device; nothing about it was sent. */
  readonly localFailure: LocalFailure | null;
  /** Not `ready`, nothing moving it, and this tab still holds its envelopes, so it can be sent again under the same id. */
  readonly resendable: boolean;
  /** The original filename, for an item this device is adding. On this screen only; never sent. */
  readonly name: string | null;
  readonly thumb: OwnerThumb;
  readonly size: { readonly w: number; readonly h: number } | null;
};

export type RemoveStatement =
  /** Never `ready`: no recipient could have retrieved it (api-sketch §9.5, §11.2). */
  | "never-ready"
  /** No recipient's last_opened_at is later than the item's created_at. */
  | "unopened"
  | "opened";

export type RemoveConfirm = {
  readonly key: string;
  /** Null while the statement is being computed. */
  readonly statement: RemoveStatement | null;
  readonly removing: boolean;
};

export type AlbumScreen = {
  readonly kind: "album";
  readonly id: string;
  /** Null when the title would not open (flows §3.4: shown, not hidden). */
  readonly title: string | null;
  readonly phase: "loading" | "ready";
  readonly items: readonly MediaItem[];
  readonly viewer: Viewer | null;
  readonly confirm: RemoveConfirm | null;
  /** Removed items whose erasure the relay reported pending, retried while this screen is open. */
  readonly erasurePending: number;
  /** Asked to leave while uploads are in flight: they stop if the owner goes. */
  readonly leaving: boolean;
};

// ── What it needs from the session ─────────────────────────────────────────

export type AlbumContext = {
  readonly api: OwnerApi;
  readonly token: string;
  readonly envelope: Envelope;
  readonly albumKey: AlbumKey;
  readonly imaging: Imaging;
  readonly decodeImage: (bytes: Uint8Array) => Promise<Picture>;
  readonly newMediaId: () => string;
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly nextFrames: () => Promise<void>;
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /** OwnerSession.call, bound to the epoch this album was opened in: 401, offline, 5xx and 429 are handled there. */
  readonly call: <T>(op: () => Promise<T>) => Promise<T>;
  /** True for the session's own "this operation is stale" error. */
  readonly isStale: (e: unknown) => boolean;
  /** Runs a task; an unexpected error shows the retryable offline state and runs it again (OwnerSession.guarded). */
  readonly guarded: (task: () => Promise<void>) => void;
  readonly screen: () => AlbumScreen | null;
  readonly show: (s: AlbumScreen) => void;
  /** The album is gone (404): back to the list. */
  readonly gone: () => void;
};

/** api-sketch §11.5: 300 a minute per token. Spaced at 240 a minute, leaving room for everything else. */
export const PACE_MS = 250;
/**
 * When a `pending` or `processing` row with nothing on this device moving it
 * counts as stalled. The relay has no number for this (api-sketch §9.7 defers
 * the sweep); a photo goes `ready` within a second and the upload deadline is
 * 120 s, so five minutes is well past any honest upload. A client choice.
 */
export const STALL_MS = 5 * 60 * 1000;
/** How long to poll for `ready` after both objects are sent, before leaving the row to show its state. */
export const POLL_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000, 30000] as const;
const REMOVE_BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 60000] as const;
const THUMB_CONCURRENCY = 4;

/** Thrown through anything this album started, once it has been left. */
class Left extends Error {
  override readonly name = "Left";
}

type Held = { readonly asset: Uint8Array<ArrayBuffer>; readonly thumb: Uint8Array<ArrayBuffer>; readonly size: { w: number; h: number } };
type Job = { readonly key: string; readonly file: File } | { readonly key: string; readonly resend: string };

const decodeBlob = (b64: string) => decodeBase64urlRange(b64, 1, 64 * 1024 * 1024);
const failedWith = (e: unknown, status: number): boolean => e instanceof ApiFailure && e.status === status;

export class OwnerAlbum {
  private alive = true;
  private readonly queue: Job[] = [];
  private pumping = false;
  /** Envelopes for items this tab sent, until the server says `ready`. Ciphertext only. */
  private readonly held = new Map<string, Held>();
  private localCount = 0;
  private nextSlot = 0;
  private viewerGen = 0;
  private readonly timers = new Set<() => void>();
  private readonly removing = new Set<string>();

  constructor(
    private readonly ctx: AlbumContext,
    readonly albumId: string,
  ) {}

  // ── Lifetime ───────────────────────────────────────────────────────────

  private check(): void {
    if (!this.alive) throw new Left();
  }

  private stopped(e: unknown): boolean {
    return e instanceof Left || this.ctx.isStale(e) || !this.alive;
  }

  /** True while this device has a photo between choosing and the server's answer. */
  get busy(): boolean {
    return this.pumping || this.queue.length > 0;
  }

  /** Every picture closed, every timer cancelled, every envelope dropped. Nothing started here continues. */
  dispose(closePictures = true): void {
    if (!this.alive) return;
    this.alive = false;
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.queue.length = 0;
    this.held.clear();
    const s = this.ctx.screen();
    if (closePictures && s !== null && s.id === this.albumId) {
      for (const i of s.items) if (i.thumb.kind === "ready") i.thumb.picture.close();
      s.viewer?.picture?.close();
    }
  }

  private screen(): AlbumScreen {
    this.check();
    const s = this.ctx.screen();
    if (s === null || s.id !== this.albumId) throw new Left();
    return s;
  }

  private show(patch: Partial<AlbumScreen>): void {
    this.ctx.show({ ...this.screen(), ...patch });
  }

  private item(key: string): MediaItem | undefined {
    return this.screen().items.find((i) => i.key === key);
  }

  private update(key: string, patch: Partial<MediaItem>): boolean {
    const s = this.screen();
    if (!s.items.some((i) => i.key === key)) return false;
    this.ctx.show({ ...s, items: s.items.map((i) => (i.key === key ? withStall({ ...i, ...patch }, this.ctx.now()) : i)) });
    return true;
  }

  private drop(key: string): void {
    const s = this.screen();
    const gone = s.items.find((i) => i.key === key);
    if (gone?.thumb.kind === "ready") gone.thumb.picture.close();
    this.ctx.show({ ...s, items: s.items.filter((i) => i.key !== key) });
  }

  private async call<T>(op: () => Promise<T>): Promise<T> {
    this.check();
    const out = await this.ctx.call(op);
    this.check();
    return out;
  }

  /** The upload path's requests, spaced (api-sketch §11.5). 429s are still waited out inside call(). */
  private async paced<T>(op: () => Promise<T>): Promise<T> {
    this.check();
    const now = this.ctx.now().getTime();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + PACE_MS;
    if (wait > 0) await this.ctx.sleep(wait);
    return this.call(op);
  }

  private run(task: () => Promise<void>): void {
    this.ctx.guarded(async () => {
      try {
        await task();
      } catch (e) {
        if (this.stopped(e)) return;
        throw e;
      }
    });
  }

  private timer(ms: number, fn: () => void): void {
    const cancel = this.ctx.setTimer(ms, () => {
      this.timers.delete(cancel);
      if (!this.alive) return;
      try {
        fn();
      } catch (e) {
        if (!this.stopped(e)) throw e;
      }
    });
    this.timers.add(cancel);
  }

  // ── §3.4 Open ──────────────────────────────────────────────────────────

  start(): void {
    this.run(() => this.load());
    this.tick();
  }

  /** Stalled depends on the clock as well as the server: re-judged every minute, with no request. */
  private tick(): void {
    this.timer(60_000, () => {
      const s = this.screen();
      const now = this.ctx.now();
      const items = s.items.map((i) => withStall(i, now));
      if (items.some((i, n) => i !== s.items[n])) this.show({ items });
      this.tick();
    });
  }

  private async load(): Promise<void> {
    const { api, token } = this.ctx;
    let details;
    let metadata;
    try {
      [details, metadata] = await Promise.all([this.call(() => api.album(token, this.albumId)), this.call(() => api.metadata(token, this.albumId))]);
    } catch (e) {
      if (failedWith(e, 404)) {
        this.check();
        return this.ctx.gone();
      }
      throw e;
    }
    const envelopes = new Map(metadata.metadata.map((m) => [m.media_id, m.envelope]));
    const items: MediaItem[] = details.media.map((m) => {
      const base = blank(m.id, m.id);
      if (m.status !== "ready") return { ...base, status: m.status, createdAt: m.created_at };
      const size = this.openMeta(m.id, envelopes.get(m.id));
      return { ...base, status: m.status, createdAt: m.created_at, size, thumb: size === null ? { kind: "unavailable" } : { kind: "loading" } };
    });
    // Anything this device added while the list loaded stays, after the server's rows.
    const local = this.screen().items.filter((i) => !items.some((x) => x.id !== null && x.id === i.id));
    this.show({ phase: "ready", items: [...items, ...local] });
    this.loadThumbs(items.filter((i) => i.thumb.kind === "loading").map((i) => i.key));
    // updated_at is only on §9.8: one status request per row that is not ready, paced.
    for (const i of items) if (i.status !== "ready") await this.refreshStatus(i.key);
  }

  /** Null when the envelope is missing or will not open: that one cell is unavailable, never the album. */
  private openMeta(id: string, envelope: string | undefined): MediaItem["size"] {
    if (envelope === undefined) return null;
    try {
      const plain = this.ctx.envelope.decryptMeta(this.ctx.albumKey, uuidToBytes(id), decodeBlob(envelope));
      const size = readSize(new TextDecoder().decode(plain));
      plain.fill(0);
      return size;
    } catch (e) {
      if (e instanceof EnvelopeUnavailable) throw e;
      return null;
    }
  }

  private async refreshStatus(key: string): Promise<void> {
    const id = this.item(key)?.id;
    if (id === null || id === undefined) return;
    let st: MediaStatusBody;
    try {
      st = await this.paced(() => this.ctx.api.mediaStatus(this.ctx.token, id));
    } catch (e) {
      if (failedWith(e, 404)) return this.drop(key); // removed from another tab or device
      throw e;
    }
    const was = this.item(key);
    if (was === undefined || was.local !== null) return;
    this.update(key, { status: st.status, createdAt: st.created_at, updatedAt: st.updated_at });
    if (st.status === "ready" && was.status !== "ready") await this.becameReady(key, id, null);
  }

  /** The server said `ready`. Only now is the item shown as done. */
  private async becameReady(key: string, id: string, known: Held["size"] | null): Promise<void> {
    let size = known;
    if (size === null) {
      const all = await this.call(() => this.ctx.api.metadata(this.ctx.token, this.albumId));
      size = this.openMeta(id, all.metadata.find((m) => m.media_id === id)?.envelope);
    }
    this.update(key, { status: "ready", local: null, resendable: false, size, thumb: size === null ? { kind: "unavailable" } : { kind: "loading" } });
    if (size !== null) this.loadThumbs([key]);
  }

  // ── Thumbnails: fetched freely, never logged (api-sketch §11.6) ────────

  private loadThumbs(keys: readonly string[]): void {
    const queue = [...keys];
    const worker = async (): Promise<void> => {
      for (let k = queue.shift(); k !== undefined; k = queue.shift()) await this.loadThumb(k);
    };
    for (let i = 0; i < Math.min(THUMB_CONCURRENCY, queue.length); i++) this.run(worker);
  }

  private async loadThumb(key: string): Promise<void> {
    const id = this.item(key)?.id;
    if (id === null || id === undefined) return;
    let picture: Picture;
    try {
      const object = await this.call(() => this.ctx.api.thumbnail(this.ctx.token, id));
      const plain = this.ctx.envelope.decryptThumb(this.ctx.albumKey, uuidToBytes(id), object);
      try {
        picture = await this.ctx.decodeImage(plain);
      } finally {
        plain.fill(0);
      }
    } catch (e) {
      if (this.stopped(e) || e instanceof EnvelopeUnavailable) throw e;
      if (failedWith(e, 404)) return this.drop(key);
      this.update(key, { thumb: { kind: "failed" } });
      return;
    }
    if (!this.alive || !this.update(key, { thumb: { kind: "ready", picture } })) picture.close();
  }

  retryThumb(key: string): void {
    if (this.item(key)?.thumb.kind !== "failed") return;
    this.update(key, { thumb: { kind: "loading" } });
    this.run(() => this.loadThumb(key));
  }

  // ── §3.6 Upload ────────────────────────────────────────────────────────

  add(files: readonly File[]): void {
    const s = this.screen();
    if (s.phase !== "ready" || files.length === 0) return;
    const added = files.map((file) => {
      const key = `local-${++this.localCount}`;
      this.queue.push({ key, file });
      return { ...blank(key, null), local: "queued" as const, name: file.name };
    });
    this.show({ items: [...s.items, ...added] });
    this.pump();
  }

  /** An item not `ready` whose envelopes this tab still holds: sent again under the same id (api-sketch §9.7). */
  resend(key: string): void {
    const i = this.item(key);
    if (i === undefined || i.id === null || !this.canResend(i.id, i.status) || i.local !== null) return;
    this.queue.push({ key, resend: i.id });
    this.update(key, { local: "queued", resendable: false });
    this.pump();
  }

  /** A local failure has no server row: dismissing it is all there is. */
  dismiss(key: string): void {
    if (this.item(key)?.localFailure == null) return;
    this.drop(key);
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    this.run(async () => {
      try {
        // One at a time, from decode to the server's answer: one decoded photo in memory at most.
        for (let job = this.queue.shift(); job !== undefined; job = this.queue.shift()) await this.one(job);
      } finally {
        this.pumping = false;
      }
    });
  }

  private async one(job: Job): Promise<void> {
    try {
      if ("file" in job) await this.fresh(job.key, job.file);
      else await this.send(job.key, job.resend);
    } catch (e) {
      if (this.stopped(e) || e instanceof EnvelopeUnavailable) throw e;
      // Unanticipated, for this item only: it fails, and the next one runs.
      const i = this.alive ? this.item(job.key) : undefined;
      if (i === undefined) return;
      // The server's status stays as last reported: this device never decides it.
      if (i.id !== null && i.status !== null) this.update(job.key, { local: null, resendable: this.canResend(i.id, i.status) });
      else this.update(job.key, { local: null, localFailure: "not-encrypted" });
    }
  }

  private async fresh(key: string, file: File): Promise<void> {
    this.update(key, { local: "preparing" });
    await this.ctx.nextFrames();
    this.check();
    const r = await prepare(file, this.ctx.imaging);
    this.check();
    if (!r.ok) {
      // Never uploaded: not unstripped, not unscaled, not as the original file (#11, #14, #17).
      this.update(key, { local: null, localFailure: r.error });
      return;
    }
    const { asset, thumb, meta, size } = r.prepared;

    this.update(key, { local: "encrypting" });
    // Flows §3.6 step 2: the id first, because it is in every envelope's header.
    const id = this.ctx.newMediaId();
    let sealed: { asset: Uint8Array<ArrayBuffer>; thumb: Uint8Array<ArrayBuffer>; meta: Uint8Array };
    try {
      const idBytes = uuidToBytes(id);
      const env = this.ctx.envelope;
      const k = this.ctx.albumKey;
      sealed = {
        asset: env.encryptAsset(k, idBytes, asset) as Uint8Array<ArrayBuffer>,
        thumb: env.encryptThumb(k, idBytes, thumb) as Uint8Array<ArrayBuffer>,
        meta: env.encryptMeta(k, idBytes, meta),
      };
    } catch (e) {
      if (e instanceof EnvelopeUnavailable) throw e;
      this.update(key, { local: null, localFailure: "not-encrypted" });
      return;
    } finally {
      asset.fill(0);
      thumb.fill(0);
      meta.fill(0);
    }
    const dims = { w: size.width, h: size.height };
    this.held.set(id, { asset: sealed.asset, thumb: sealed.thumb, size: dims });
    this.update(key, { id, local: "uploading", name: null });

    // §9.6. Network loss and 5xx are resent by call() with the same id and body.
    try {
      const created = await this.paced(() => this.ctx.api.createMedia(this.ctx.token, this.albumId, id, sealed.meta));
      this.update(key, { status: created.status, createdAt: created.created_at });
    } catch (e) {
      if (failedWith(e, 409)) {
        // Our own lost response: already created. The same id, never a new one.
        this.update(key, { status: "pending" });
      } else if (e instanceof ApiFailure && !this.stopped(e)) {
        // 400, 404, 413, 415: refused, so no row exists and nothing was stored.
        this.held.delete(id);
        this.update(key, { id: null, local: null, localFailure: "refused" });
        return;
      } else throw e;
    }
    await this.send(key, id);
  }

  /** Flows §3.6 steps 4 and 5: both objects, then the server's `ready`. */
  private async send(key: string, id: string): Promise<void> {
    const held = this.held.get(id);
    if (held === undefined) return;
    this.update(key, { local: "uploading" });
    let st: MediaStatusBody | null = null;
    for (const variant of ["asset", "thumbnail"] as const) {
      if (this.removing.has(id)) return;
      try {
        st = await this.paced(() => this.ctx.api.upload(this.ctx.token, id, variant, variant === "asset" ? held.asset : held.thumb));
      } catch (e) {
        if (failedWith(e, 409)) {
          // Refused because the row is already `ready` (a resend whose first attempt landed): ask.
          st = await this.paced(() => this.ctx.api.mediaStatus(this.ctx.token, id));
          break;
        }
        if (failedWith(e, 404)) {
          this.held.delete(id);
          return this.drop(key);
        }
        if (e instanceof ApiFailure && !this.stopped(e)) {
          // 400, 411, 413, 415: this upload cannot succeed as sent.
          this.update(key, { local: null, status: "failed", resendable: false });
          this.held.delete(id);
          return;
        }
        throw e;
      }
      this.update(key, { status: st.status, createdAt: st.created_at, updatedAt: st.updated_at });
      if (st.status === "failed") break;
    }
    if (st === null) return;

    this.update(key, { local: "waiting" });
    for (const delay of POLL_DELAYS_MS) {
      if (st.status === "ready" || st.status === "failed") break;
      await this.ctx.sleep(delay);
      this.check();
      if (this.removing.has(id)) return;
      try {
        st = await this.paced(() => this.ctx.api.mediaStatus(this.ctx.token, id));
      } catch (e) {
        if (failedWith(e, 404)) {
          this.held.delete(id);
          return this.drop(key);
        }
        throw e;
      }
      this.update(key, { status: st.status, updatedAt: st.updated_at });
    }

    if (st.status === "ready") {
      this.held.delete(id);
      return this.becameReady(key, id, held.size);
    }
    // `failed`, or still `processing` after polling: shown as the server last said, and
    // stalled once its updated_at is old. Never "done". It can be sent again while this
    // tab holds its envelopes (§9.7 allows re-upload in any state but `ready`).
    this.update(key, { local: null, resendable: this.canResend(id, st.status) });
  }

  private canResend(id: string, status: MediaStatus | null): boolean {
    return this.held.has(id) && status !== null && status !== "ready";
  }

  // ── §3.4, §4.5 Viewer: the full asset, only when shown ─────────────────

  openViewer(key: string): void {
    const s = this.screen();
    const ready = s.items.filter((i) => i.status === "ready" && i.size !== null);
    const index = ready.findIndex((i) => i.key === key);
    const item = ready[index];
    if (item?.id == null || s.viewer !== null || s.confirm !== null) return;
    const gen = ++this.viewerGen;
    const id = item.id;
    this.show({ viewer: { index, id, phase: "loading", picture: null } });
    this.run(async () => {
      let object: Uint8Array<ArrayBuffer>;
      try {
        object = await this.call(() => this.ctx.api.asset(this.ctx.token, id));
      } catch (e) {
        if (this.stopped(e)) throw e;
        this.setViewer(gen, { phase: failedWith(e, 404) ? "removed" : "failed", picture: null });
        return;
      }
      let picture: Picture;
      try {
        const plain = this.ctx.envelope.decryptAsset(this.ctx.albumKey, uuidToBytes(id), object);
        try {
          picture = await this.ctx.decodeImage(plain);
        } finally {
          plain.fill(0);
        }
      } catch (e) {
        if (e instanceof EnvelopeUnavailable) throw e;
        this.setViewer(gen, { phase: "failed", picture: null });
        return;
      }
      if (!this.alive || !this.setViewer(gen, { phase: "shown", picture })) picture.close();
    });
  }

  private setViewer(gen: number, v: Pick<Viewer, "phase" | "picture">): boolean {
    if (!this.alive || gen !== this.viewerGen) return false;
    const s = this.screen();
    if (s.viewer === null) return false;
    this.show({ viewer: { ...s.viewer, ...v } });
    return true;
  }

  closeViewer(): void {
    const s = this.screen();
    if (s.viewer === null) return;
    this.viewerGen++;
    s.viewer.picture?.close();
    this.show({ viewer: null });
  }

  // ── §3.7 Remove ────────────────────────────────────────────────────────

  /** From any server status, once nothing on this device is moving the item. */
  askRemove(key: string): void {
    const s = this.screen();
    const i = s.items.find((x) => x.key === key);
    if (i?.id == null || i.status === null || i.local !== null || s.confirm !== null || s.viewer !== null) return;
    const id = i.id;
    this.show({ confirm: { key, statement: null, removing: false } });
    this.run(async () => {
      let status = i.status;
      let createdAt = i.createdAt;
      if (status !== "ready") {
        // Read again: another device may have finished it since the album loaded, and "never ready" must be true now.
        try {
          const st = await this.paced(() => this.ctx.api.mediaStatus(this.ctx.token, id));
          status = st.status;
          createdAt = st.created_at;
          this.update(key, { status: st.status, createdAt: st.created_at, updatedAt: st.updated_at });
        } catch (e) {
          if (!failedWith(e, 404)) throw e;
          this.show({ confirm: null });
          return this.drop(key);
        }
      }
      let statement: RemoveStatement;
      if (status !== "ready") statement = "never-ready";
      else {
        const log = await this.call(() => this.ctx.api.accessLog(this.ctx.token, this.albumId));
        const added = createdAt === null ? NaN : Date.parse(createdAt);
        // created_at is earlier than ready, so this errs towards "opened" (flows §3.7). An unreadable time counts as opened.
        const opened = log.recipients.some((r) => r.last_opened_at !== null && !(Date.parse(r.last_opened_at) <= added));
        statement = opened ? "opened" : "unopened";
      }
      const now = this.screen().confirm;
      if (now?.key === key && !now.removing) this.show({ confirm: { ...now, statement } });
    });
  }

  cancelRemove(): void {
    const c = this.screen().confirm;
    if (c === null || c.removing) return;
    this.show({ confirm: null });
  }

  confirmRemove(): void {
    const s = this.screen();
    const c = s.confirm;
    const id = s.items.find((i) => i.key === c?.key)?.id;
    if (c === null || c.statement === null || c.removing || id == null) return;
    this.show({ confirm: { ...c, removing: true } });
    this.removing.add(id);
    this.run(async () => {
      const outcome = await this.removeOnce(id);
      this.held.delete(id);
      this.show({ confirm: null });
      this.drop(c.key);
      if (outcome === "pending") {
        this.show({ erasurePending: this.screen().erasurePending + 1 });
        this.retryErasure(id, 0);
      }
    });
  }

  private async removeOnce(id: string): Promise<"erased" | "pending"> {
    try {
      return await this.call(() => this.ctx.api.removeMedia(this.ctx.token, id));
    } catch (e) {
      // 404: already removed from another tab or device, or erased by an earlier try. Done.
      if (failedWith(e, 404)) return "erased";
      throw e;
    }
  }

  /** While this screen is open, and only then (flows §3.7). Leaving cancels it. */
  private retryErasure(id: string, attempt: number): void {
    const delay = REMOVE_BACKOFF_MS[Math.min(attempt, REMOVE_BACKOFF_MS.length - 1)] ?? 60000;
    this.timer(delay, () =>
      this.run(async () => {
        const outcome = await this.removeOnce(id);
        if (outcome === "pending") return this.retryErasure(id, attempt + 1);
        this.show({ erasurePending: Math.max(0, this.screen().erasurePending - 1) });
      }),
    );
  }

  // ── Leaving ────────────────────────────────────────────────────────────

  askLeave(open: boolean): void {
    this.show({ leaving: open });
  }
}

function blank(key: string, id: string | null): MediaItem {
  return {
    key,
    id,
    status: null,
    createdAt: null,
    updatedAt: null,
    stalled: false,
    local: null,
    localFailure: null,
    resendable: false,
    name: null,
    thumb: { kind: "none" },
    size: null,
  };
}

/** Stalled: not ready, nothing here moving it, and the server's updated_at is old (flows §3.4). */
export function withStall(i: MediaItem, now: Date): MediaItem {
  const old = i.updatedAt !== null && now.getTime() - Date.parse(i.updatedAt) > STALL_MS;
  const stalled = (i.status === "pending" || i.status === "processing") && i.local === null && old;
  return stalled === i.stalled ? i : { ...i, stalled };
}

export { Left as AlbumLeft };
