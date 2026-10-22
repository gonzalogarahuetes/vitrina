/*
 * Recipients and revoke (flows §3.9) and the access log (flows §3.10), as a
 * part of the owner session in the way the open album is. It borrows its
 * album's AlbumKey to open labels and thumbnails, and holds no key.
 *
 * Rules this file is the enforcement of:
 *   - The list comes from the access-log summary, the only route that lists
 *     an album's recipients (api-sketch §11.7). Revoked recipients stay
 *     listed, marked.
 *   - Revoke is idempotent: a resend after a lost response is the same
 *     revoke, and its answer is success. A `404` means this screen is stale,
 *     so it is refreshed, and says so.
 *   - The log is paged by `next_before`, newest first, and never prefetched
 *     beyond the page asked for.
 *   - A photo named in an entry is drawn from the owner's own thumbnail. One
 *     that is no longer in the album (hidden, not yet erased) has a drawn
 *     state of its own. Thumbnails never log (api-sketch §11.6), so drawing
 *     them changes nothing in the log being read.
 */
import { ApiFailure } from "$lib/api/client";
import { EnvelopeUnavailable, type Envelope } from "$lib/envelope";
import { uuidToBytes } from "$lib/ids";
import type { AlbumKey } from "$lib/keys/owner-types";
import type { Picture } from "$lib/recipient/render";
import { decodeBase64urlRange } from "@vitrina/shared";
import type { OwnerThumb } from "./album";
import type { AccessLogEntry, AccessLogEvent, AccessLogRecipient, OwnerApi } from "./api";

export type PersonView = {
  readonly id: string;
  /** Null when the label would not open: the person is still listed (as albums are, flows §3.4). */
  readonly label: string | null;
  readonly revokedAt: string | null;
  readonly albumOpens: number;
  readonly mediaOpened: number;
  readonly lastOpenedAt: string | null;
};

export type RevokeConfirm = {
  readonly id: string;
  readonly busy: boolean;
  /** The relay refused it with something other than 404. Nothing changed. */
  readonly failed: boolean;
};

export type PeopleScreen = {
  readonly kind: "people";
  readonly albumId: string;
  readonly albumTitle: string | null;
  readonly phase: "loading" | "ready";
  readonly people: readonly PersonView[];
  readonly revoke: RevokeConfirm | null;
  /** A revoke met 404: the list was out of date, and has been fetched again. */
  readonly refreshed: boolean;
  /** The person this screen just revoked, for revoke.done. */
  readonly justRevoked: string | null;
};

export type LogPhoto =
  /** In the album: its own thumbnail, drawn as the album draws it. */
  | { readonly kind: "photo"; readonly thumb: OwnerThumb }
  /** No longer in the album: hidden and not yet erased (flows §3.10). Erasure takes its entries with it. */
  | { readonly kind: "removed" };

export type LogEntryView = {
  readonly id: number;
  readonly recipientId: string;
  /** Null when unreadable, or for a recipient this screen does not know. */
  readonly label: string | null;
  readonly event: AccessLogEvent;
  readonly occurredAt: string;
  readonly mediaId: string | null;
};

export type LogScreen = {
  readonly kind: "log";
  readonly albumId: string;
  readonly albumTitle: string | null;
  /** Filtered to one recipient, or every entry. */
  readonly recipientId: string | null;
  /** That recipient's label, when filtered and readable. */
  readonly recipientLabel: string | null;
  readonly phase: "loading" | "ready" | "more";
  readonly entries: readonly LogEntryView[];
  /** next_before was not null. */
  readonly hasMore: boolean;
  /** By media id, for every asset_viewed entry shown. */
  readonly photos: Readonly<Record<string, LogPhoto>>;
};

export type PeopleContext = {
  readonly api: OwnerApi;
  readonly token: string;
  readonly envelope: Envelope;
  readonly albumKey: AlbumKey;
  readonly albumId: string;
  readonly albumTitle: string | null;
  readonly decodeImage: (bytes: Uint8Array) => Promise<Picture>;
  readonly call: <T>(op: () => Promise<T>) => Promise<T>;
  readonly isStale: (e: unknown) => boolean;
  readonly guarded: (task: () => Promise<void>) => void;
  readonly screen: () => PeopleScreen | LogScreen | null;
  readonly show: (s: PeopleScreen | LogScreen) => void;
  readonly gone: () => void;
};

class Left extends Error {
  override readonly name = "PeopleLeft";
}

const failedWith = (e: unknown, status: number): boolean => e instanceof ApiFailure && e.status === status;

export class AlbumPeople {
  private alive = true;
  /** The people screen as last shown, to come back to from the log. */
  private people: PeopleScreen;
  private labels = new Map<string, string | null>();
  private log: LogScreen | null = null;
  private nextBefore: number | null = null;
  /** Media ids present in the album, from GET /v1/albums/{id}, fetched once per log view. */
  private present: Map<string, string> | null = null;
  /** Bumped whenever the log view opens or closes: work begun for an older view stops. */
  private logSeq = 0;

  constructor(private readonly ctx: PeopleContext) {
    this.people = { kind: "people", albumId: ctx.albumId, albumTitle: ctx.albumTitle, phase: "loading", people: [], revoke: null, refreshed: false, justRevoked: null };
  }

  start(): void {
    this.ctx.show(this.people);
    this.load(false);
  }

  dispose(): void {
    this.alive = false;
    this.closeLog();
  }

  private live(): void {
    if (!this.alive) throw new Left();
  }

  private showPeople(p: Partial<PeopleScreen>): void {
    this.live();
    this.people = { ...this.people, ...p };
    if (this.ctx.screen()?.kind === "people") this.ctx.show(this.people);
  }

  private showLog(p: Partial<LogScreen>): void {
    this.live();
    if (this.log === null) return;
    this.log = { ...this.log, ...p };
    if (this.ctx.screen()?.kind === "log") this.ctx.show(this.log);
  }

  private openLabel(r: AccessLogRecipient): string | null {
    try {
      const blob = decodeBase64urlRange(r.label, 41, 64 * 1024);
      return this.ctx.envelope.decryptRecipientLabel(this.ctx.albumKey, uuidToBytes(r.recipient_id), blob);
    } catch (e) {
      if (e instanceof EnvelopeUnavailable) throw e;
      return null;
    }
  }

  private load(refreshed: boolean): void {
    this.ctx.guarded(async () => {
      let summary;
      try {
        summary = await this.ctx.call(() => this.ctx.api.accessLog(this.ctx.token, this.ctx.albumId));
      } catch (e) {
        if (failedWith(e, 404)) return this.ctx.gone();
        throw e;
      }
      this.live();
      const people = summary.recipients.map((r): PersonView => {
        const label = this.openLabel(r);
        this.labels.set(r.recipient_id, label);
        return { id: r.recipient_id, label, revokedAt: r.revoked_at, albumOpens: r.album_opens, mediaOpened: r.media_opened, lastOpenedAt: r.last_opened_at };
      });
      this.showPeople({ phase: "ready", people, revoke: null, refreshed, justRevoked: null });
    });
  }

  // ── Revoke (flows §3.9) ─────────────────────────────────────────────────

  askRevoke(id: string): void {
    const p = this.people;
    const person = p.people.find((x) => x.id === id);
    if (p.phase !== "ready" || p.revoke?.busy === true || person === undefined || person.revokedAt !== null) return;
    this.showPeople({ revoke: { id, busy: false, failed: false }, refreshed: false, justRevoked: null });
  }

  cancelRevoke(): void {
    if (this.people.revoke?.busy === false) this.showPeople({ revoke: null });
  }

  confirmRevoke(): void {
    const r = this.people.revoke;
    if (r === null || r.busy) return;
    this.showPeople({ revoke: { ...r, busy: true, failed: false } });
    this.ctx.guarded(async () => {
      let revokedAt: string;
      try {
        // Idempotent: call() resends after offline or a 5xx, and the repeat answers the original revoked_at.
        revokedAt = (await this.ctx.call(() => this.ctx.api.revokeRecipient(this.ctx.token, r.id))).revoked_at;
      } catch (e) {
        if (this.ctx.isStale(e)) throw e;
        if (failedWith(e, 404)) {
          // flows §3.9: the screen is stale. Fetch the list again, and say so.
          this.showPeople({ revoke: null, phase: "loading" });
          return this.load(true);
        }
        if (e instanceof ApiFailure) return this.showPeople({ revoke: { ...r, busy: false, failed: true } });
        throw e;
      }
      this.showPeople({
        revoke: null,
        justRevoked: r.id,
        people: this.people.people.map((x) => (x.id === r.id ? { ...x, revokedAt } : x)),
      });
    });
  }

  // ── The access log (flows §3.10) ────────────────────────────────────────

  openLog(recipientId: string | null): void {
    if (this.people.phase !== "ready" || this.people.revoke !== null) return;
    this.closeLog();
    this.log = { kind: "log", albumId: this.ctx.albumId, albumTitle: this.ctx.albumTitle, recipientId, recipientLabel: recipientId === null ? null : (this.labels.get(recipientId) ?? null), phase: "loading", entries: [], hasMore: false, photos: {} };
    this.nextBefore = null;
    this.logSeq++;
    this.ctx.show(this.log);
    this.page(true);
  }

  moreLog(): void {
    if (this.log?.phase !== "ready" || this.nextBefore === null) return;
    this.showLog({ phase: "more" });
    this.page(false);
  }

  /** Back to the list, as it was. Every thumbnail the log decoded is closed. */
  closeLogView(): void {
    if (this.log === null) return;
    this.closeLog();
    this.live();
    this.ctx.show(this.people);
  }

  private closeLog(): void {
    const log = this.log;
    this.logSeq++;
    this.log = null;
    this.present = null;
    if (log === null) return;
    for (const p of Object.values(log.photos)) if (p.kind === "photo" && p.thumb.kind === "ready") p.thumb.picture.close();
  }

  private page(first: boolean): void {
    const log = this.log;
    const seq = this.logSeq;
    if (log === null) return;
    this.ctx.guarded(async () => {
      try {
        if (this.present === null) {
          const details = await this.ctx.call(() => this.ctx.api.album(this.ctx.token, this.ctx.albumId));
          if (seq !== this.logSeq) return;
          this.present = new Map(details.media.map((m) => [m.id, m.status]));
        }
        const before = first ? undefined : (this.nextBefore ?? undefined);
        const page = await this.ctx.call(() =>
          this.ctx.api.accessLogEntries(this.ctx.token, this.ctx.albumId, {
            ...(log.recipientId === null ? {} : { recipientId: log.recipientId }),
            ...(before === undefined ? {} : { before }),
          }),
        );
        this.live();
        if (seq !== this.logSeq) return;
        this.nextBefore = page.next_before;
        const entries = page.entries.map((e) => this.entryView(e));
        const current = this.log;
        if (current === null) return;
        const photos: Record<string, LogPhoto> = { ...current.photos };
        const toLoad: string[] = [];
        for (const e of entries) {
          if (e.mediaId === null || photos[e.mediaId] !== undefined) continue;
          const status = this.present?.get(e.mediaId);
          if (status === undefined) photos[e.mediaId] = { kind: "removed" };
          else if (status !== "ready") photos[e.mediaId] = { kind: "photo", thumb: { kind: "none" } };
          else {
            photos[e.mediaId] = { kind: "photo", thumb: { kind: "loading" } };
            toLoad.push(e.mediaId);
          }
        }
        this.showLog({ phase: "ready", entries: [...current.entries, ...entries], hasMore: page.next_before !== null, photos });
        for (const id of toLoad) this.loadThumb(id);
      } catch (e) {
        if (failedWith(e, 404)) return this.ctx.gone();
        throw e;
      }
    });
  }

  private entryView(e: AccessLogEntry): LogEntryView {
    return { id: e.id, recipientId: e.recipient_id, label: this.labels.get(e.recipient_id) ?? null, event: e.event, occurredAt: e.occurred_at, mediaId: e.media_id };
  }

  private setPhoto(id: string, photo: LogPhoto): boolean {
    const log = this.log;
    if (!this.alive || log === null) return false;
    this.showLog({ photos: { ...log.photos, [id]: photo } });
    return true;
  }

  private loadThumb(id: string): void {
    const seq = this.logSeq;
    this.ctx.guarded(async () => {
      let picture: Picture;
      try {
        const object = await this.ctx.call(() => this.ctx.api.thumbnail(this.ctx.token, id));
        if (seq !== this.logSeq) return;
        const plain = this.ctx.envelope.decryptThumb(this.ctx.albumKey, uuidToBytes(id), object);
        picture = await this.ctx.decodeImage(plain);
      } catch (e) {
        if (this.ctx.isStale(e) || e instanceof EnvelopeUnavailable) throw e;
        // Removed between the details fetch and now: drawn as removed. Anything else: this cell failed.
        if (seq === this.logSeq) this.setPhoto(id, failedWith(e, 404) ? { kind: "removed" } : { kind: "photo", thumb: { kind: "failed" } });
        return;
      }
      if (seq !== this.logSeq || !this.setPhoto(id, { kind: "photo", thumb: { kind: "ready", picture } })) picture.close();
    });
  }
}

export { Left as PeopleLeft };
