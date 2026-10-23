/*
 * Create invite (flows §3.8), as a part of the owner session in the way the
 * open album is: OwnerSession owns key state and every request's failure
 * handling (401, offline, 5xx, 429); this owns what the invite screen shows.
 * It borrows its album's AlbumKey and holds no key of its own.
 *
 * Rules this file is the enforcement of:
 *   - Every secret an invite needs comes from the owner's two functions
 *     (lib/keys/owner-open.ts). Nothing here generates an id, a token, a key
 *     or a word, and nothing here hashes, wraps or derives.
 *   - Order: generate → encrypt the label → POST → share, and the share
 *     screen only after `201`. A `409` regenerates everything, in both modes,
 *     and re-encrypts the label, because the id is in the wrap AAD and K_label
 *     derives from it. A network failure resends the same body (call()), since
 *     that is the same create, not a new one. Each id given up on is revoked
 *     once afterwards, in case a lost response had already created it.
 *   - The share screen is shown once. Its link, words and QR exist only in
 *     this screen's state; leaving drops them, and nothing about the invite is
 *     stored anywhere. Leaving asks first.
 *   - Passphrase languages are the vetted lists that exist, loaded only when
 *     passphrase mode is chosen. Nothing assumes English.
 */
import { ApiFailure } from "$lib/api/client";
import { EnvelopeUnavailable, type Envelope } from "$lib/envelope";
import { uuidToBytes } from "$lib/ids";
import { inviteLink } from "$lib/invite/url";
import type { AlbumKey, OwnerKeyFunctions, PassphraseInvite, QrInvite, Wordlist } from "$lib/keys/owner-types";
import type { OwnerApi } from "./api";
import { codePoints } from "./policy";

export type InviteMode = "qr" | "passphrase";

export type InviteStep =
  | "form"
  /** Passphrase only: Argon2id is running (flows §2). Nothing can be edited or submitted. */
  | "deriving"
  /** Encrypting the label and POST /recipients. */
  | "creating"
  /** After `201`, once. */
  | "share";

export type InviteProblem =
  | "label-empty"
  | "label-too-long"
  /** Passphrase mode with no vetted list to draw from, or one the key function refused. */
  | "no-language"
  /** The relay refused the create (400, 413, 415), or kept answering 409. Nothing was shared. */
  | "failed"
  /** The key function could not finish on this device (flows §2's third exit). Never a wrong input. */
  | "device";

export type InviteShare =
  | { readonly kind: "qr"; readonly label: string; readonly link: string }
  | { readonly kind: "passphrase"; readonly label: string; readonly link: string; readonly words: readonly string[]; readonly language: string };

export type InviteScreen = {
  readonly kind: "invite";
  readonly albumId: string;
  readonly albumTitle: string | null;
  readonly step: InviteStep;
  readonly mode: InviteMode;
  /** The vetted passphrase languages: not asked for until passphrase mode is chosen. */
  readonly languages: "idle" | "loading" | "failed" | readonly string[];
  readonly language: string | null;
  readonly problem: InviteProblem | null;
  /** Non-null only on the share step. */
  readonly share: InviteShare | null;
  /** On the share step: asked to leave, which loses the link for good. */
  readonly leaving: boolean;
};

export type InviteContext = {
  readonly api: OwnerApi;
  readonly token: string;
  readonly envelope: Envelope;
  readonly albumKey: AlbumKey;
  readonly albumId: string;
  readonly albumTitle: string | null;
  readonly keys: Pick<OwnerKeyFunctions, "createQrInvite" | "createPassphraseInvite">;
  /** The wordlist chunk, dynamically imported. */
  readonly loadWordlists: () => Promise<readonly Wordlist[]>;
  /** The owner's display language: the default passphrase language when a list exists for it (brief §15.2). */
  readonly displayLanguage: string;
  /** This page's origin, which is the relay a web invite names (invite spec §1). */
  readonly origin: string;
  readonly nextFrames: () => Promise<void>;
  readonly call: <T>(op: () => Promise<T>) => Promise<T>;
  readonly isStale: (e: unknown) => boolean;
  readonly guarded: (task: () => Promise<void>) => void;
  readonly poisoned: () => boolean;
  readonly screen: () => InviteScreen | null;
  readonly show: (s: InviteScreen) => void;
  /** The album is gone (404): back to the list. */
  readonly gone: () => void;
};

/** The label is drawn into the watermark (brief §5): a name, not a paragraph. */
export const LABEL_MAX_CODE_POINTS = 60;
/** 409s in a row before giving up. Each is a fresh id and token, so a second one is already a bug somewhere. */
export const MAX_CREATE_ATTEMPTS = 3;

class Left extends Error {
  override readonly name = "InviteLeft";
}

export class InviteFlow {
  private alive = true;
  private wordlists: readonly Wordlist[] | null = null;

  constructor(private readonly ctx: InviteContext) {}

  start(): void {
    this.ctx.show({
      kind: "invite",
      albumId: this.ctx.albumId,
      albumTitle: this.ctx.albumTitle,
      step: "form",
      mode: "qr",
      languages: "idle",
      language: null,
      problem: null,
      share: null,
      leaving: false,
    });
  }

  /** Drops everything, the share view with it. Nothing continues after this. */
  dispose(): void {
    this.alive = false;
    this.wordlists = null;
  }

  /** True while leaving would interrupt something: the derivation wait or the create. */
  get busy(): boolean {
    const s = this.ctx.screen();
    return s !== null && (s.step === "deriving" || s.step === "creating");
  }

  /** True on the share step: leaving loses the link, so it asks first. */
  get sharing(): boolean {
    return this.ctx.screen()?.step === "share";
  }

  private current(): InviteScreen {
    const s = this.ctx.screen();
    if (!this.alive || s === null) throw new Left();
    return s;
  }

  private patch(p: Partial<InviteScreen>): void {
    this.ctx.show({ ...this.current(), ...p });
  }

  chooseMode(mode: InviteMode): void {
    const s = this.current();
    if (s.step !== "form") return;
    this.patch({ mode, problem: s.problem === "no-language" ? null : s.problem });
    if (mode === "passphrase" && (s.languages === "idle" || s.languages === "failed")) this.loadLanguages();
  }

  chooseLanguage(language: string): void {
    const s = this.current();
    if (s.step !== "form" || !Array.isArray(s.languages) || !s.languages.includes(language)) return;
    this.patch({ language, problem: s.problem === "no-language" ? null : s.problem });
  }

  retryLanguages(): void {
    const s = this.current();
    if (s.step === "form" && s.languages === "failed") this.loadLanguages();
  }

  private loadLanguages(): void {
    this.patch({ languages: "loading" });
    this.ctx
      .loadWordlists()
      .then((lists) => {
        if (!this.alive) return;
        this.wordlists = lists;
        const codes = lists.map((l) => l.language);
        const language = codes.includes(this.ctx.displayLanguage) ? this.ctx.displayLanguage : (codes[0] ?? null);
        this.patch({ languages: codes, language });
      })
      .catch(() => {
        // A static chunk on this origin that would not load: being offline, in effect. Retryable.
        if (this.alive && this.ctx.screen() !== null) this.patch({ languages: "failed" });
      });
  }

  create(rawLabel: string): void {
    const s = this.current();
    if (s.step !== "form") return;
    const label = rawLabel.trim();
    if (label === "") return this.patch({ problem: "label-empty" });
    if (codePoints(label) > LABEL_MAX_CODE_POINTS) return this.patch({ problem: "label-too-long" });
    let list: Wordlist | undefined;
    if (s.mode === "passphrase") {
      list = this.wordlists?.find((l) => l.language === s.language);
      if (list === undefined) return this.patch({ problem: "no-language" });
    }
    const mode = s.mode;
    this.patch({ step: mode === "qr" ? "creating" : "deriving", problem: null });
    this.ctx.guarded(() => this.run(mode, label, list));
  }

  private async run(mode: InviteMode, label: string, list: Wordlist | undefined): Promise<void> {
    // Ids given up on after a 409. One may be a row the relay did store, from a
    // send whose response was lost: its token was discarded, so it can never be
    // used, but the owner would see a recipient they never sent. Revoking it
    // lists it honestly. A 404 just means it was never created.
    const abandoned: string[] = [];
    try {
      await this.attempts(mode, label, list, abandoned);
    } finally {
      this.revokeAbandoned(abandoned);
    }
  }

  /** One attempt each, best effort, never awaited: nothing on screen waits for it, and a failure leaves an unusable row active. */
  private revokeAbandoned(ids: readonly string[]): void {
    if (!this.alive) return;
    for (const id of ids) void this.ctx.api.revokeRecipient(this.ctx.token, id).catch(() => undefined);
  }

  private async attempts(mode: InviteMode, label: string, list: Wordlist | undefined, abandoned: string[]): Promise<void> {
    const { ctx } = this;
    const fail = (problem: InviteProblem): void => {
      if (this.alive && ctx.screen() !== null) this.patch({ step: "form", problem });
    };
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
      // 1. Every secret, from the owner's functions. A 409 comes back here.
      let invite: QrInvite | PassphraseInvite;
      if (mode === "qr") {
        const r = await ctx.keys.createQrInvite(ctx.envelope, ctx.albumKey);
        if (!this.alive) return;
        if (!r.ok) {
          if (ctx.poisoned()) throw new EnvelopeUnavailable("trapped");
          return fail("device");
        }
        invite = r.invite;
      } else {
        // The derivation wait is painted before Argon2id blocks the thread.
        this.patch({ step: "deriving" });
        await ctx.nextFrames();
        if (!this.alive) return;
        const r = await ctx.keys.createPassphraseInvite(ctx.envelope, ctx.albumKey, list as Wordlist);
        if (!this.alive) return;
        if (!r.ok) {
          if (ctx.poisoned()) throw new EnvelopeUnavailable("trapped");
          return fail(r.error === "unusable-wordlist" ? "no-language" : "device");
        }
        invite = r.invite;
      }

      // 2. The label, under K_label of this attempt's id.
      let labelBlob: Uint8Array;
      try {
        labelBlob = ctx.envelope.encryptRecipientLabel(ctx.albumKey, uuidToBytes(invite.recipientId), label);
      } catch (e) {
        if (e instanceof EnvelopeUnavailable) throw e;
        return fail("failed");
      }

      // 3. POST. Offline and 5xx resend this same body inside call().
      this.patch({ step: "creating" });
      try {
        await ctx.call(() =>
          ctx.api.createRecipient(
            ctx.token,
            ctx.albumId,
            invite.kind === "qr"
              ? { id: invite.recipientId, kind: "qr", label: labelBlob, tokenHash: invite.tokenHash, wrapped: invite.wrapped, wrapNonce: invite.wrapNonce }
              : {
                  id: invite.recipientId,
                  kind: "passphrase",
                  label: labelBlob,
                  tokenHash: invite.tokenHash,
                  wrapped: invite.wrapped,
                  wrapNonce: invite.wrapNonce,
                  kdfSalt: invite.kdfSalt,
                  params: invite.params,
                },
          ),
        );
      } catch (e) {
        if (ctx.isStale(e) || !this.alive) throw e;
        // flows §3.8: regenerate the id and the token, and redo the wrap. Never resend this one.
        if (e instanceof ApiFailure && e.status === 409) {
          abandoned.push(invite.recipientId);
          continue;
        }
        if (e instanceof ApiFailure && e.status === 404) return ctx.gone();
        if (e instanceof ApiFailure) return fail("failed");
        throw e;
      }
      if (!this.alive) return;

      // 4. Only now is there anything to share.
      const link = inviteLink({
        origin: ctx.origin,
        albumId: uuidToBytes(ctx.albumId),
        token: invite.token,
        ...(invite.kind === "qr" ? { inviteKey: invite.inviteKey } : {}),
      });
      const share: InviteShare =
        invite.kind === "qr"
          ? { kind: "qr", label, link }
          : { kind: "passphrase", label, link, words: invite.words, language: (list as Wordlist).language };
      this.patch({ step: "share", share, leaving: false });
      return;
    }
    fail("failed");
  }

  /** The share step's way out: ask first, because the link cannot be shown again. */
  askLeave(open: boolean): void {
    const s = this.current();
    if (s.step !== "share") return;
    this.patch({ leaving: open });
  }
}

export { Left as InviteLeft };
