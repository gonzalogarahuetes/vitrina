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
 *   - The filename and the caption are in the metadata envelope and nowhere
 *     else. The filename is shown on this screen for local items only, and
 *     never sent in plaintext; the caption is shown in the viewer.
 *   - Choosing photos opens a review (flows §3.6, before step 1): previews,
 *     a caption per photo, rows that can be taken out. Nothing is prepared,
 *     encrypted or sent until the owner sends, and no request is made.
 *   - Every chosen file is read into memory at once, when chosen, and never
 *     read again: on the test phone (Vivaldi for Android, which is Chromium;
 *     Chrome itself not yet tried) a picked file stopped being readable within
 *     seconds (found on the phone walk, 23 October 2026). Those bytes are the original,
 *     EXIF and GPS included, so they are zeroed, not just dropped, once the
 *     photo is prepared, taken out, cancelled, or the album is left. What is
 *     held is capped (ORIGINALS_CAP).
 *   - One full-size decode at a time, previews and preparation together.
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
import { readMeta, type Meta, type Viewer } from "$lib/recipient/session";
import { decodeBase64urlRange } from "@vitrina/shared";
import type { MediaStatusBody, OwnerApi } from "./api";
import { captionValue, checkCaption } from "./caption";
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
  /** From the metadata envelope, once the item is `ready` and it opened. */
  readonly caption: string | null;
};

export type Preview = { readonly kind: "loading" } | { readonly kind: "ready"; readonly picture: Picture } | { readonly kind: "failed" };

/** A chosen photo, before anything happens to it. */
export type ReviewRow = {
  readonly key: string;
  /** The original filename: on this screen only, never sent. */
  readonly name: string;
  /** Its bytes, read when chosen: still reading, held, or unreadable (pick it again). */
  readonly read: "reading" | "ok" | "unreadable";
  readonly preview: Preview;
  /** As typed; caption.ts decides what is stored. */
  readonly caption: string;
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
  /** The photos just chosen, before "Send": nothing about them has been prepared or sent. */
  readonly review: { readonly rows: readonly ReviewRow[] } | null;
  /** The last choice was refused: with what is already held it would pass ORIGINALS_CAP. */
  readonly chooseRefused: boolean;
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
  /** A small, upright picture of a chosen photo, for the review step only (preview.ts). */
  readonly preview: (file: File) => Promise<Picture>;
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
/**
 * The most original bytes held at once: chosen and not yet prepared, review
 * and queue together. 100 MB (decimal, as phones show file sizes), decided
 * 23 October 2026: on the test phone those bytes share memory with one
 * full-size decode during preparation. Raise only after measuring there.
 */
export const ORIGINALS_CAP = 100_000_000;
const REMOVE_BACKOFF_MS = [2000, 4000, 8000, 16000, 32000, 60000] as const;
const THUMB_CONCURRENCY = 4;

/** Thrown through anything this album started, once it has been left. */
class Left extends Error {
  override readonly name = "Left";
}

type Held = { readonly asset: Uint8Array<ArrayBuffer>; readonly thumb: Uint8Array<ArrayBuffer>; readonly meta: Meta };
/** A chosen photo's bytes, read once when chosen. Zeroed once prepared, taken out, cancelled or left. */
type Original = { readonly bytes: Uint8Array<ArrayBuffer>; readonly name: string; readonly type: string };
type Job = { readonly key: string; readonly original: Original; readonly caption: string | null } | { readonly key: string; readonly resend: string };

/** A copy for one decode. A Blob cannot be zeroed: it lives only as long as that decode holds it. */
const asFile = (o: Original): File => new File([o.bytes], o.name, { type: o.type });

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
  /** The review's originals, by row key, once read. Moved to the queue on send; zeroed on take out, cancel and dispose. */
  private readonly picked = new Map<string, Original>();
  /** Declared sizes of reads still in flight, by row key: counted against the cap. */
  private readonly reading = new Map<string, number>();
  /** The original being prepared right now, out of the queue and not yet zeroed. */
  private preparing: Original | null = null;
  private pickCount = 0;
  private previewing = false;
  /** Serialises every full-size decode: previews and preparation never overlap (brief §11). */
  private decodeTurn: Promise<unknown> = Promise.resolve();

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
    for (const job of this.queue) if ("original" in job) job.original.bytes.fill(0);
    this.queue.length = 0;
    this.held.clear();
    for (const o of this.picked.values()) o.bytes.fill(0);
    this.picked.clear();
    this.preparing?.bytes.fill(0);
    // A read still in flight is zeroed when it lands (choose: `!this.alive`). The one being prepared, by one()'s finally.
    const s = this.ctx.screen();
    if (closePictures && s !== null && s.id === this.albumId) {
      for (const i of s.items) if (i.thumb.kind === "ready") i.thumb.picture.close();
      s.viewer?.picture?.close();
      for (const r of s.review?.rows ?? []) if (r.preview.kind === "ready") r.preview.picture.close();
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

  /** One full-size decode at a time, whoever asks. */
  private exclusive<T>(op: () => Promise<T>): Promise<T> {
    const turn = this.decodeTurn.then(op, op);
    this.decodeTurn = turn.catch(() => undefined);
    return turn;
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
      const meta = this.openMeta(m.id, envelopes.get(m.id));
      return {
        ...base,
        status: m.status,
        createdAt: m.created_at,
        size: meta?.size ?? null,
        caption: meta?.caption ?? null,
        thumb: meta === null ? { kind: "unavailable" } : { kind: "loading" },
      };
    });
    // Anything this device added while the list loaded stays, after the server's rows.
    const local = this.screen().items.filter((i) => !items.some((x) => x.id !== null && x.id === i.id));
    this.show({ phase: "ready", items: [...items, ...local] });
    this.loadThumbs(items.filter((i) => i.thumb.kind === "loading").map((i) => i.key));
    // updated_at is only on §9.8: one status request per row that is not ready, paced.
    for (const i of items) if (i.status !== "ready") await this.refreshStatus(i.key);
  }

  /** Null when the envelope is missing or will not open: that one cell is unavailable, never the album. */
  private openMeta(id: string, envelope: string | undefined): Meta | null {
    if (envelope === undefined) return null;
    try {
      const plain = this.ctx.envelope.decryptMeta(this.ctx.albumKey, uuidToBytes(id), decodeBlob(envelope));
      const meta = readMeta(new TextDecoder().decode(plain));
      plain.fill(0);
      return meta;
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
  private async becameReady(key: string, id: string, known: Meta | null): Promise<void> {
    let meta = known;
    if (meta === null) {
      const all = await this.call(() => this.ctx.api.metadata(this.ctx.token, this.albumId));
      meta = this.openMeta(id, all.metadata.find((m) => m.media_id === id)?.envelope);
    }
    this.update(key, {
      status: "ready",
      local: null,
      resendable: false,
      size: meta?.size ?? null,
      caption: meta?.caption ?? null,
      thumb: meta === null ? { kind: "unavailable" } : { kind: "loading" },
    });
    if (meta !== null) this.loadThumbs([key]);
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

  // ── §3.6 Review: previews and captions, before anything is prepared ────

  /** What the cap counts: every original held or being read, review and queue together. */
  private heldBytes(): number {
    let n = this.preparing?.bytes.byteLength ?? 0;
    for (const o of this.picked.values()) n += o.bytes.byteLength;
    for (const size of this.reading.values()) n += size;
    for (const job of this.queue) if ("original" in job) n += job.original.bytes.byteLength;
    return n;
  }

  /**
   * The photos just chosen. Every file is read now, all at once, before
   * anything else: on the test phone's Chromium-based browser a picked file stopped being readable
   * within seconds of the picker returning, and only this moment is reliable.
   * A choice that would hold more than ORIGINALS_CAP is refused whole, and
   * nothing of it is read. Opens the review; nothing is prepared, encrypted or
   * sent from here.
   */
  choose(files: readonly File[]): void {
    const s = this.screen();
    if (s.phase !== "ready" || files.length === 0 || s.viewer !== null || s.confirm !== null) return;
    const declared = files.reduce((n, f) => n + f.size, 0);
    if (this.heldBytes() + declared > ORIGINALS_CAP) {
      this.show({ chooseRefused: true });
      return;
    }
    const picks = files.map((file) => {
      const key = `pick-${++this.pickCount}`;
      this.reading.set(key, file.size);
      // Called now, synchronously, for every file: a thrown read becomes a rejection here.
      const read = (async () => new Uint8Array(await file.arrayBuffer()))();
      return { key, file, read };
    });
    const rows = picks.map(({ key, file }): ReviewRow => ({ key, name: file.name, read: "reading", preview: { kind: "loading" }, caption: "" }));
    this.show({ chooseRefused: false, review: { rows: [...(s.review?.rows ?? []), ...rows] } });
    for (const { key, file, read } of picks) {
      this.run(async () => {
        let bytes: Uint8Array<ArrayBuffer> | null;
        try {
          bytes = await read;
        } catch {
          bytes = null;
        }
        this.reading.delete(key);
        // Taken out, cancelled or left while reading: nothing will use these bytes.
        if (!this.alive || !this.hasRow(key)) {
          bytes?.fill(0);
          return;
        }
        if (bytes === null) {
          this.setRow(key, { read: "unreadable", preview: { kind: "failed" } });
          return;
        }
        this.picked.set(key, { bytes, name: file.name, type: file.type });
        this.setRow(key, { read: "ok" });
        this.previewNext();
      });
    }
  }

  setCaption(key: string, caption: string): void {
    this.setRow(key, { caption });
  }

  /** Takes a photo out of the selection: it is never prepared or sent, and its bytes are zeroed. */
  unpick(key: string): void {
    const r = this.screen().review;
    const row = r?.rows.find((x) => x.key === key);
    if (r == null || row === undefined) return;
    if (row.preview.kind === "ready") row.preview.picture.close();
    this.picked.get(key)?.bytes.fill(0);
    this.picked.delete(key);
    const rows = r.rows.filter((x) => x.key !== key);
    this.show({ review: rows.length === 0 ? null : { rows } });
  }

  cancelReview(): void {
    const r = this.screen().review;
    if (r === null) return;
    for (const row of r.rows) {
      if (row.preview.kind === "ready") row.preview.picture.close();
      this.picked.get(row.key)?.bytes.fill(0);
      this.picked.delete(row.key);
    }
    this.show({ review: null });
  }

  /** The rows Send will send: read and held. An unreadable one is left behind with its message. */
  static sendable(rows: readonly ReviewRow[]): readonly ReviewRow[] {
    return rows.filter((r) => r.read === "ok");
  }

  /** "Send N photos": only now does anything happen to them, in the order shown. */
  sendReview(): void {
    const s = this.screen();
    const r = s.review;
    if (r === null || r.rows.some((row) => row.read === "reading")) return;
    const send = OwnerAlbum.sendable(r.rows);
    if (send.length === 0 || send.some((row) => checkCaption(row.caption) !== "ok")) return;
    const added = r.rows.flatMap((row) => {
      if (row.preview.kind === "ready") row.preview.picture.close();
      const original = this.picked.get(row.key);
      this.picked.delete(row.key);
      if (original === undefined) return [];
      const key = `local-${++this.localCount}`;
      this.queue.push({ key, original, caption: captionValue(row.caption) });
      return [{ ...blank(key, null), local: "queued" as const, name: original.name }];
    });
    this.show({ review: null, items: [...s.items, ...added] });
    this.pump();
  }

  private hasRow(key: string): boolean {
    const s = this.ctx.screen();
    return s !== null && s.id === this.albumId && (s.review?.rows.some((x) => x.key === key) ?? false);
  }

  private setRow(key: string, patch: Partial<ReviewRow>): boolean {
    const r = this.screen().review;
    if (r === null || !r.rows.some((x) => x.key === key)) return false;
    this.show({ review: { rows: r.rows.map((x) => (x.key === key ? { ...x, ...patch } : x)) } });
    return true;
  }

  /** One preview at a time, in the order chosen, from the held bytes. A row taken out meanwhile has its preview closed. */
  private previewNext(): void {
    if (this.previewing) return;
    this.previewing = true;
    this.run(async () => {
      try {
        for (;;) {
          const row = this.screen().review?.rows.find((x) => x.read === "ok" && x.preview.kind === "loading" && this.picked.has(x.key));
          if (row === undefined) return;
          const original = this.picked.get(row.key) as Original;
          let picture: Picture | null;
          try {
            picture = await this.exclusive(() => this.ctx.preview(asFile(original)));
          } catch {
            picture = null;
          }
          if (!this.alive) {
            picture?.close();
            return;
          }
          const placed = this.setRow(row.key, { preview: picture === null ? { kind: "failed" } : { kind: "ready", picture } });
          if (!placed) picture?.close();
        }
      } finally {
        this.previewing = false;
      }
    });
  }

  // ── §3.6 Upload ────────────────────────────────────────────────────────

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
      if ("original" in job) {
        this.preparing = job.original;
        try {
          await this.fresh(job.key, job.original, job.caption);
        } finally {
          // Already zeroed by fresh() once prepared; this covers a stop before preparation began.
          job.original.bytes.fill(0);
          this.preparing = null;
        }
      } else await this.send(job.key, job.resend);
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

  private async fresh(key: string, original: Original, caption: string | null): Promise<void> {
    this.update(key, { local: "preparing" });
    await this.ctx.nextFrames();
    this.check();
    // From the bytes read when chosen, never the picked file again. Zeroed the moment
    // preparation is over, whatever its outcome: encryption and sending need only its output.
    let r: Awaited<ReturnType<typeof prepare>>;
    try {
      r = await this.exclusive(() => prepare(asFile(original), this.ctx.imaging, caption));
    } finally {
      original.bytes.fill(0);
      this.preparing = null;
    }
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
    const known: Meta = { size: { w: size.width, h: size.height }, caption };
    this.held.set(id, { asset: sealed.asset, thumb: sealed.thumb, meta: known });
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
      return this.becameReady(key, id, held.meta);
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
    if (item?.id == null || s.viewer !== null || s.confirm !== null || s.review !== null) return;
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
    if (i?.id == null || i.status === null || i.local !== null || s.confirm !== null || s.viewer !== null || s.review !== null) return;
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
    caption: null,
  };
}

/** Stalled: not ready, nothing here moving it, and the server's updated_at is old (flows §3.4). */
export function withStall(i: MediaItem, now: Date): MediaItem {
  const old = i.updatedAt !== null && now.getTime() - Date.parse(i.updatedAt) > STALL_MS;
  const stalled = (i.status === "pending" || i.status === "processing") && i.local === null && old;
  return stalled === i.stalled ? i : { ...i, stalled };
}

export { Left as AlbumLeft };
