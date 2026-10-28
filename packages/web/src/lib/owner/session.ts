/*
 * The owner path as one state machine: flows §1.1's key states (O-none,
 * O-locked, O-open) and the screens of §3.1–§3.5, §3.8–§3.12. It is
 * plain TypeScript, so the whole path runs under test with a recording fetch,
 * a fake envelope, a fake store and fakes of the owner's eight key functions.
 *
 * Key state, and what may change it:
 *   - sessionStorage holds the token and its expires_at, and nothing else,
 *     only through the injected SessionStore (lib/session/owner-session.ts).
 *   - In memory: the OwnerKeyMaterial (O-locked), the OwnerKek (between
 *     /login and /owner/key only), the MasterKey and every AlbumKey (O-open).
 *   - An owner 401 from any route, in any state: clear storage, free every
 *     handle, go to sign-in (flows §1.1).
 *   - The open album (album.ts) is part of O-open: it holds no key of its
 *     own, borrows its album's AlbumKey, and is disposed with everything else.
 *     So are an album's invite screen (invite.ts) and its people and access
 *     log (people.ts). Only one of the three is open at a time.
 *   - A WASM trap: device failed. Nothing is freed, because the instance is
 *     poisoned and must not be touched (envelope.ts). The token is kept, so a
 *     reload comes back to unlock.
 * A network failure is an offline state that changes no key state (flows §0).
 * 429 waits for Retry-After.
 */
import {
  ApiFailure,
  NetworkFailure,
  UnexpectedResponse,
  type ApiClient,
} from "$lib/api/client";
import { EnvelopeUnavailable, type Envelope, type Poison } from "$lib/envelope";
import { uuidToBytes } from "$lib/ids";
import type {
  AlbumKey,
  MasterKey,
  OwnerKeyFunctions,
  OwnerKek,
  OwnerKeyMaterial,
  Wordlist,
} from "$lib/keys/owner-types";
import type { SessionStore } from "$lib/session/owner-session";
import { decodeBase64urlRange } from "@vitrina/shared";
import type { Picture } from "$lib/recipient/render";
import { AlbumLeft, OwnerAlbum, type AlbumScreen } from "./album";
import { ownerApi, type AlbumRow, type OwnerApi } from "./api";
import {
  InviteFlow,
  InviteLeft,
  type InviteMode,
  type InviteScreen,
} from "./invite";
import {
  AlbumPeople,
  PeopleLeft,
  type LogScreen,
  type PeopleScreen,
} from "./people";
import type { Imaging } from "./prepare";
import { checkPassword, codePoints } from "./policy";

// ── Screens ──────────────────────────────────────────────────────────────

/** Why the sign-in screen is showing, when that is worth saying. */
export type SigninNotice = "session-ended" | "signed-out" | null;

export type SigninPhase =
  | "ready"
  /** A request is in flight: /login/params, /login, /owner/key or /albums. */
  | "busy"
  | "deriving"
  /** 401 INVALID_CREDENTIALS, or a password no account can have. Never says which half was wrong. */
  | "failed"
  /** A service problem: a 400 or 5xx, or parameters this device cannot use. */
  | "unavailable"
  /** A 429 (flows §0's credential-route exception): no key material held; submit waits for `pausedUntil`. */
  | "paused";

export type SignupPhase =
  | "ready"
  /** The blocklist is loading, or POST /v1/signup is in flight. */
  | "busy"
  | "deriving"
  | "too-short"
  | "too-long"
  | "common"
  | "invalid"
  /** 409: the address is registered. */
  | "taken"
  /** 400, 413 or 415: a client build error (api-sketch §7.5). */
  | "failed"
  /** A 429: no account was created, and nothing is held. Never signup-uncertain (flows §0). */
  | "paused"
  /** 403 SIGNUP_NOT_ALLOWED: not invited. No account was created, and nothing is held. */
  | "not-allowed";

export type UnlockPhase =
  | "ready"
  | "empty"
  | "deriving"
  | "wrong"
  | "unavailable";

export type AlbumView = {
  readonly id: string;
  readonly mediaCount: number;
  /** Null when it could not be opened. The album is still listed (flows §3.4). */
  readonly title: string | null;
  readonly failed: null | "key" | "title";
};

export type CreatePhase =
  | "closed"
  | "open"
  | "empty"
  | "too-long"
  | "creating"
  | "failed";

export type LogoutScope = "device" | "everywhere";

export type Screen =
  /** Page load with a token: GET /v1/owner/key before any password is asked for. */
  | { readonly kind: "checking" }
  | {
      readonly kind: "signin";
      readonly phase: SigninPhase;
      readonly notice: SigninNotice;
      /** The address the form is created with (a prefill), not what is typed in it. Constant during an attempt. */
      readonly email: string;
      /** While `paused`: when submitting may resume, in ms on the device's clock. Null otherwise. */
      readonly pausedUntil: number | null;
    }
  | {
      readonly kind: "signup";
      readonly phase: SignupPhase;
      readonly pausedUntil: number | null;
    }
  | { readonly kind: "signup-uncertain"; readonly email: string }
  | {
      readonly kind: "unlock";
      readonly phase: UnlockPhase;
      readonly signingOut: boolean;
    }
  | { readonly kind: "cannot-unlock" }
  | { readonly kind: "device-failed" }
  | {
      readonly kind: "albums";
      readonly phase: "loading" | "ready";
      readonly albums: readonly AlbumView[];
      readonly create: CreatePhase;
      readonly signingOut: LogoutScope | null;
    }
  | AlbumScreen
  | InviteScreen
  | PeopleScreen
  | LogScreen
  | {
      readonly kind: "signed-out-partial";
      readonly scope: LogoutScope;
      readonly retrying: boolean;
    };

export type Expiry = { readonly endsAt: Date; readonly ending: boolean };

export type State = {
  readonly screen: Screen;
  readonly offline: boolean;
  /** Waiting out a 429's Retry-After on a token route. Credential routes pause their form instead (flows §0). */
  readonly rateLimited: boolean;
  /** From the stored expires_at, on the device's clock. Null outside a session. */
  readonly expiry: Expiry | null;
};

export type Deps = {
  readonly client: ApiClient;
  readonly envelope: Envelope;
  readonly poison: Poison;
  readonly keys: OwnerKeyFunctions;
  readonly store: SessionStore;
  /** The blocklist, dynamically imported. Called by signup only. */
  readonly loadBlocklist: () => Promise<ReadonlySet<string>>;
  /** crypto.randomUUID() in the browser: a lowercase UUIDv4. */
  readonly newAlbumId: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  /** Two animation frames, so the derivation wait is painted before Argon2id blocks. */
  readonly nextFrames: () => Promise<void>;
  readonly now: () => Date;
  /** setTimeout, cancellable. */
  readonly setTimer: (ms: number, fn: () => void) => () => void;
  /** Decoding and canvas re-encoding for upload (prepare.ts; imaging.ts in the browser). */
  readonly imaging: Imaging;
  /** createImageBitmap(new Blob([bytes])) in the browser: no URL is made for a decrypted image. */
  readonly decodeImage: (bytes: Uint8Array) => Promise<Picture>;
  /** The upload review's small, upright preview of a chosen photo, for the screen only (preview.ts). */
  readonly preview: (file: File) => Promise<Picture>;
  /** crypto.randomUUID() in the browser: the media id, which is the envelopes' asset_id. */
  readonly newMediaId: () => string;
  /** The passphrase wordlists, dynamically imported: a chunk only passphrase invite creation loads. */
  readonly loadWordlists: () => Promise<readonly Wordlist[]>;
  /** The owner's display language, the default passphrase language (brief §15.2). Read each time an invite opens. */
  readonly displayLanguage: string;
  /** location.origin: the relay a web invite names (invite spec §1). */
  readonly origin: string;
};

/** How long before expires_at the warning shows (flows §3.12). */
export const EXPIRY_WARNING_MS = 24 * 60 * 60 * 1000;
export const TITLE_MAX_CODE_POINTS = 200;

const DEFAULT_RETRY_AFTER_S = 5;
/** setTimeout's ceiling. A longer wait is scheduled in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Thrown through an operation whose key state has since been reset. */
class Stale extends Error {
  override readonly name = "Stale";
}

/** Not the API's answer, or a 5xx: the service, not the user and not the key. */
const serverFault = (e: unknown): boolean =>
  (e instanceof ApiFailure && e.status >= 500) ||
  e instanceof UnexpectedResponse;

const failedWith = (e: unknown, status: number): boolean =>
  e instanceof ApiFailure && e.status === status;

type CallOptions = {
  /** NetworkFailure: wait for the offline retry (default), or throw to the caller. */
  readonly network?: "wait" | "throw";
  /** 5xx or a malformed response: wait (default), or throw. */
  readonly server?: "wait" | "throw";
  /** 401: end the session (default), or throw (for /login's INVALID_CREDENTIALS). */
  readonly unauthorized?: "end" | "throw";
  /** 429: wait for Retry-After and resend (default), or throw (the credential routes, flows §0). */
  readonly rateLimit?: "wait" | "throw";
};

/** The credential routes: no silent retry of anything, and a 429 comes back to the caller (flows §0). */
const CREDENTIAL: CallOptions = {
  server: "throw",
  unauthorized: "throw",
  rateLimit: "throw",
};

export class OwnerSession {
  private state: State = {
    screen: { kind: "checking" },
    offline: false,
    rateLimited: false,
    expiry: null,
  };
  private readonly listeners = new Set<(s: State) => void>();
  private readonly api: OwnerApi;

  // Key state. None of it is serialised; only token and expiresAt are stored.
  private token: string | null = null;
  private expiresAt: string | null = null;
  private material: OwnerKeyMaterial | null = null;
  private kek: OwnerKek | null = null;
  private master: MasterKey | null = null;
  private readonly albumKeys = new Map<string, AlbumKey>();
  /** The open album, if any. Holds decrypted pictures and envelopes, never a key of its own. */
  private album: OwnerAlbum | null = null;
  /** An album's invite screen, if open. Its share view lives only here, and only until it closes. */
  private invite: InviteFlow | null = null;
  /** An album's people and access log, if open. */
  private people: AlbumPeople | null = null;
  /** Where to go once the album, asked to leave during an upload, is left. */
  private afterLeave: "invite" | "people" | null = null;
  /** The album list as last shown, to go back to. */
  private albumList: readonly AlbumView[] = [];

  /** Bumped whenever key state is reset. An operation from an older epoch is stale. */
  private epoch = 0;
  private dead = false;
  private online: { promise: Promise<void>; resolve: () => void } | null = null;
  private cancelExpiry: (() => void) | null = null;
  private blocklist: Promise<ReadonlySet<string>> | null = null;
  private logoutInFlight = false;
  private cancelPause: (() => void) | null = null;

  constructor(private readonly deps: Deps) {
    this.api = ownerApi(deps.client);
    deps.poison.onPoison(() => this.deviceFailed());
  }

  get current(): State {
    return this.state;
  }

  subscribe(listener: (s: State) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  private emit(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  private set(screen: Screen): void {
    if (screen.kind === "albums") this.albumList = screen.albums;
    this.emit({ screen });
  }

  private closeAlbum(): void {
    const a = this.album;
    this.album = null;
    a?.dispose();
    const i = this.invite;
    this.invite = null;
    i?.dispose();
    const p = this.people;
    this.people = null;
    p?.dispose();
  }

  // ── Key state: the only places it is dropped ───────────────────────────

  private freeHandles(): void {
    this.closeAlbum();
    if (this.deps.poison.poisoned) {
      // A trapped instance must not be touched. Drop the references only.
      this.kek = null;
      this.master = null;
      this.albumKeys.clear();
      return;
    }
    const all: { free(): void }[] = [...this.albumKeys.values()];
    if (this.master !== null) all.push(this.master);
    if (this.kek !== null) all.push(this.kek);
    this.albumKeys.clear();
    this.master = null;
    this.kek = null;
    for (const h of all) {
      try {
        h.free();
      } catch {
        // Already freed, or the instance trapped meanwhile: nothing more to do.
      }
    }
  }

  /** Drops every in-flight operation: they wake, see a newer epoch, and stop. */
  private bumpEpoch(): void {
    this.epoch++;
    const o = this.online;
    this.online = null;
    o?.resolve();
    this.cancelExpiry?.();
    this.cancelExpiry = null;
    this.cancelPause?.();
    this.cancelPause = null;
  }

  /** O-none: storage cleared, every handle freed (flows §1.1). */
  private reset(): void {
    this.bumpEpoch();
    this.freeHandles();
    this.deps.store.clear();
    this.token = null;
    this.expiresAt = null;
    this.material = null;
    this.state = {
      screen: this.state.screen,
      offline: false,
      rateLimited: false,
      expiry: null,
    };
  }

  private toSignin(notice: SigninNotice, email = ""): void {
    this.reset();
    this.set({
      kind: "signin",
      phase: "ready",
      notice,
      email,
      pausedUntil: null,
    });
  }

  /** An owner 401 anywhere. */
  private sessionEnded(): void {
    this.toSignin("session-ended");
  }

  /** Terminal for this page. The token stays stored, so a reload comes back to unlock. */
  private deviceFailed(): void {
    if (this.dead) return;
    this.dead = true;
    this.bumpEpoch();
    this.freeHandles();
    this.material = null;
    this.state = {
      screen: { kind: "device-failed" },
      offline: false,
      rateLimited: false,
      expiry: null,
    };
    for (const l of this.listeners) l(this.state);
  }

  /** Leaving the page: free everything, keep the stored token (a reload unlocks). */
  dispose(): void {
    if (this.dead) return;
    this.dead = true;
    this.bumpEpoch();
    this.freeHandles();
    this.material = null;
    this.listeners.clear();
  }

  private live(epoch: number): void {
    if (this.dead || epoch !== this.epoch) throw new Stale();
  }

  // ── Every request goes through here ────────────────────────────────────

  private async call<T>(
    epoch: number,
    op: () => Promise<T>,
    opts: CallOptions = {},
  ): Promise<T> {
    for (;;) {
      this.live(epoch);
      try {
        const out = await op();
        this.live(epoch);
        return out;
      } catch (e) {
        if (e instanceof Stale) throw e;
        this.live(epoch);
        if (e instanceof NetworkFailure && opts.network !== "throw") {
          await this.waitOnline();
          continue;
        }
        if (serverFault(e) && opts.server !== "throw") {
          await this.waitOnline();
          continue;
        }
        if (
          e instanceof ApiFailure &&
          e.status === 429 &&
          opts.rateLimit !== "throw"
        ) {
          // The request was refused before it was handled, so resending it is safe.
          this.emit({ rateLimited: true });
          await this.deps.sleep((e.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000);
          this.live(epoch);
          this.emit({ rateLimited: false });
          continue;
        }
        if (failedWith(e, 401) && opts.unauthorized !== "throw") {
          this.sessionEnded();
          throw new Stale();
        }
        throw e;
      }
    }
  }

  private waitOnline(): Promise<void> {
    if (this.online === null) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      this.online = { promise, resolve };
      this.emit({ offline: true });
    }
    return this.online.promise;
  }

  retryOffline(): void {
    const o = this.online;
    this.online = null;
    if (this.state.offline) this.emit({ offline: false });
    o?.resolve();
  }

  private guarded(epoch: number, task: () => Promise<void>): void {
    task().catch((e: unknown) => {
      if (e instanceof Stale || epoch !== this.epoch) return;
      if (e instanceof EnvelopeUnavailable || this.deps.poison.poisoned)
        return this.deviceFailed();
      // Unanticipated, and not evidence that a key is lost: show the retryable
      // state and run the same step again on retry, changing no key state.
      void this.waitOnline().then(() => {
        if (epoch === this.epoch && !this.dead) this.guarded(epoch, task);
      });
    });
  }

  // ── §3.1 Page load ─────────────────────────────────────────────────────

  start(): void {
    const stored = this.deps.store.read();
    if (stored === null)
      return this.set({
        kind: "signin",
        phase: "ready",
        notice: null,
        email: "",
        pausedUntil: null,
      });
    this.token = stored.token;
    this.expiresAt = stored.expiresAt;
    this.set({ kind: "checking" });
    this.fetchOwnerKey();
  }

  /** Settled before any password is asked for: an ended session never gets one typed into it. */
  private fetchOwnerKey(): void {
    const epoch = this.epoch;
    const token = this.token;
    if (token === null) return;
    this.guarded(epoch, async () => {
      this.material = await this.call(epoch, () => this.api.ownerKey(token));
      this.set({ kind: "unlock", phase: "ready", signingOut: false });
    });
  }

  // ── §3.1 Unlock ────────────────────────────────────────────────────────

  /** No password policy here, and no request: a wrong password is the tag failing locally. */
  submitUnlock(password: string): void {
    const s = this.state.screen;
    if (s.kind !== "unlock" || s.phase === "deriving" || s.signingOut) return;
    const material = this.material;
    if (material === null) return;
    if (password === "") return this.set({ ...s, phase: "empty" });
    const epoch = this.epoch;
    this.set({ kind: "unlock", phase: "deriving", signingOut: false });
    this.guarded(epoch, async () => {
      await this.deps.nextFrames();
      this.live(epoch);
      const r = await this.deps.keys.unlockMasterKey(
        this.deps.envelope,
        password,
        material,
      );
      if (this.dead || epoch !== this.epoch) {
        if (r.ok) this.freeQuietly(r.master);
        return;
      }
      if (!r.ok) {
        switch (r.error) {
          case "empty":
            return this.set({
              kind: "unlock",
              phase: "empty",
              signingOut: false,
            });
          case "wrong-password":
            return this.set({
              kind: "unlock",
              phase: "wrong",
              signingOut: false,
            });
          case "unusable-material":
            return this.set({
              kind: "unlock",
              phase: "unavailable",
              signingOut: false,
            });
          case "could-not-derive":
            return this.deviceFailed();
        }
      }
      this.master = r.master;
      this.material = null;
      await this.enterAlbums(epoch);
    });
  }

  /** From unlock's service-problem state: fetch the wrapping again. */
  retryUnlock(): void {
    const s = this.state.screen;
    if (s.kind !== "unlock" || s.phase !== "unavailable") return;
    this.material = null;
    this.set({ kind: "checking" });
    this.fetchOwnerKey();
  }

  // ── §3.3 Sign-in on a new device ───────────────────────────────────────

  /** The address is sent exactly as typed. No password policy here (brief §12). */
  submitSignin(email: string, password: string): void {
    const s = this.state.screen;
    if (
      s.kind !== "signin" ||
      s.phase === "busy" ||
      s.phase === "deriving" ||
      s.phase === "paused"
    )
      return;
    if (email.trim() === "" || password === "") return;
    const epoch = this.epoch;
    // `email` on the screen is the address the form is CREATED with, and
    // +page.svelte re-creates the form when it changes. So it stays as it was
    // for the whole attempt: writing the typed address here re-created the
    // form on the first submit and emptied the password field before anything
    // had happened. The form keeps what was typed itself.
    const formEmail = s.email;
    const screen = (
      phase: SigninPhase,
      pausedUntil: number | null = null,
    ): Screen => ({
      kind: "signin",
      phase,
      notice: null,
      email: formEmail,
      pausedUntil,
    });
    this.set(screen("busy"));

    this.guarded(epoch, async () => {
      // Step 1.
      let params;
      try {
        params = await this.call(
          epoch,
          () => this.api.loginParams(email),
          CREDENTIAL,
        );
      } catch (e) {
        if (e instanceof Stale) throw e;
        if (failedWith(e, 429))
          return this.pause(
            epoch,
            e as ApiFailure,
            (until) => screen("paused", until),
            () => screen("ready"),
          );
        if (e instanceof ApiFailure || e instanceof UnexpectedResponse)
          return this.set(screen("unavailable"));
        throw e;
      }

      // Step 2: the derivation wait.
      this.set(screen("deriving"));
      await this.deps.nextFrames();
      this.live(epoch);
      const d = await this.deps.keys.deriveLoginCredential(
        this.deps.envelope,
        password,
        params,
      );
      if (this.dead || epoch !== this.epoch) {
        if (d.ok) {
          d.proof.fill(0);
          this.freeQuietly(d.kek);
        }
        return;
      }
      if (!d.ok) {
        switch (d.error) {
          case "empty":
          case "invalid-password":
            return this.set(screen("failed"));
          case "unusable-material":
            return this.set(screen("unavailable"));
          case "could-not-derive":
            return this.deviceFailed();
        }
      }
      this.kek = d.kek;
      const proof = d.proof;
      this.set(screen("busy"));

      // Step 3. The proof is zeroed once /login settles, whatever the outcome.
      // A network failure is retried with the same proof, so it is kept until
      // then. Its base64url copy in the request body is a JavaScript string and
      // cannot be wiped (api-sketch §8.4).
      let session;
      try {
        session = await this.call(
          epoch,
          () => this.api.login(email, proof),
          CREDENTIAL,
        );
      } catch (e) {
        if (e instanceof Stale) throw e;
        this.freeKek();
        // flows §0: no key material is held through the wait. The proof is zeroed below.
        if (failedWith(e, 429))
          return this.pause(
            epoch,
            e as ApiFailure,
            (until) => screen("paused", until),
            () => screen("ready"),
          );
        // Identical for a wrong password and an unknown address (api-sketch §4.3).
        if (failedWith(e, 401)) return this.set(screen("failed"));
        if (e instanceof ApiFailure || e instanceof UnexpectedResponse)
          return this.set(screen("unavailable"));
        throw e;
      } finally {
        proof.fill(0);
      }
      this.saveSession(session.token, session.expires_at);

      // Step 4.
      const token = session.token;
      const material = await this.call(epoch, () => this.api.ownerKey(token));
      const kek = this.kek;
      if (kek === null) throw new Stale();
      this.kek = null; // openMasterKey frees it, on every path
      const m = this.deps.keys.openMasterKey(this.deps.envelope, kek, material);
      if (!m.ok) {
        if (m.error === "could-not-derive") return this.deviceFailed();
        // A correct password cannot cause this, so it is not a wrong password
        // (flows §3.3): revoke the session just minted, then a hard failure.
        await this.revokeQuietly(token);
        this.reset();
        return this.set({ kind: "cannot-unlock" });
      }
      this.master = m.master;

      // Step 5.
      await this.enterAlbums(epoch);
    });
  }

  private freeKek(): void {
    const k = this.kek;
    this.kek = null;
    if (k !== null) this.freeQuietly(k);
  }

  private freeQuietly(h: { free(): void }): void {
    if (this.deps.poison.poisoned) return;
    try {
      h.free();
    } catch {
      // Already freed, or trapped: nothing more to do.
    }
  }

  /** One attempt, failure ignored: used where the session is being abandoned anyway. */
  private async revokeQuietly(token: string): Promise<void> {
    try {
      await this.api.logout(token);
    } catch {
      // The token is cleared from this device either way.
    }
  }

  /**
   * flows §0, credential routes: a 429 returns to the form with a countdown
   * from Retry-After. Nothing is retried; the caller has already freed every
   * key handle and the proof is zeroed. At `until` the form becomes
   * submittable again, and a resubmit derives afresh.
   */
  private pause(
    epoch: number,
    e: ApiFailure,
    paused: (until: number) => Screen,
    resume: () => Screen,
  ): void {
    const now = this.deps.now().getTime();
    const until = now + (e.retryAfter ?? DEFAULT_RETRY_AFTER_S) * 1000;
    this.set(paused(until));
    this.cancelPause?.();
    const step = (): void => {
      const left = until - this.deps.now().getTime();
      if (left > 0) {
        this.cancelPause = this.deps.setTimer(
          Math.min(left, MAX_TIMER_MS),
          step,
        );
        return;
      }
      this.cancelPause = null;
      const s = this.state.screen;
      if (
        epoch === this.epoch &&
        !this.dead &&
        (s.kind === "signin" || s.kind === "signup") &&
        s.phase === "paused"
      )
        this.set(resume());
    };
    this.cancelPause = this.deps.setTimer(until - now, step);
  }

  /** From cannot-unlock, signin.unavailable, signup.taken and signup.uncertain. */
  backToSignin(email = ""): void {
    this.toSignin(null, email);
  }

  // ── §3.2 Signup ────────────────────────────────────────────────────────

  enterSignup(): void {
    const s = this.state.screen;
    if (s.kind !== "signin" || s.phase === "busy" || s.phase === "deriving")
      return;
    this.set({ kind: "signup", phase: "ready", pausedUntil: null });
    // Start loading the blocklist now, so it is usually ready by submit.
    this.loadBlocklist().catch(() => undefined);
  }

  private loadBlocklist(): Promise<ReadonlySet<string>> {
    const p = (this.blocklist ??= this.deps.loadBlocklist());
    p.catch(() => {
      if (this.blocklist === p) this.blocklist = null; // a failed load is retried next time
    });
    return p;
  }

  submitSignup(email: string, password: string): void {
    const s = this.state.screen;
    if (
      s.kind !== "signup" ||
      s.phase === "busy" ||
      s.phase === "deriving" ||
      s.phase === "paused"
    )
      return;
    if (email.trim() === "" || password === "") return;
    const epoch = this.epoch;
    const screen = (
      phase: SignupPhase,
      pausedUntil: number | null = null,
    ): Screen => ({ kind: "signup", phase, pausedUntil });
    this.set(screen("busy"));

    this.guarded(epoch, async () => {
      // Step 1: the policy, here and nowhere else (brief §12).
      let blocklist: ReadonlySet<string>;
      for (;;) {
        try {
          blocklist = await this.loadBlocklist();
          break;
        } catch {
          // The chunk is a static file on this origin: failing to load it is being offline.
          await this.waitOnline();
          this.live(epoch);
        }
      }
      this.live(epoch);
      const verdict = checkPassword(password, blocklist);
      if (verdict !== "ok") return this.set(screen(verdict));

      // Step 2: the derivation wait.
      this.set(screen("deriving"));
      await this.deps.nextFrames();
      this.live(epoch);
      const c = await this.deps.keys.createAccountKeys(
        this.deps.envelope,
        password,
      );
      if (this.dead || epoch !== this.epoch) {
        if (c.ok) {
          c.keys.proof.fill(0);
          this.freeQuietly(c.keys.master);
        }
        return;
      }
      if (!c.ok) {
        if (c.error === "could-not-derive") return this.deviceFailed();
        return this.set(screen("invalid"));
      }
      const keys = c.keys;
      this.master = keys.master;
      this.set(screen("busy"));

      // Step 3. Never retried blind: a lost response may have created the
      // account, and a resend would answer 409 (flows §3.2). 429 is the
      // exception, because the limiter refuses before anything is created.
      let session;
      try {
        session = await this.call(
          epoch,
          () =>
            this.api.signup({
              email,
              proof: keys.proof,
              kdfSalt: keys.kdfSalt,
              params: keys.params,
              wrappedMaster: keys.wrappedMaster,
              wrapNonce: keys.wrapNonce,
            }),
          { ...CREDENTIAL, network: "throw" },
        );
      } catch (e) {
        if (e instanceof Stale) throw e;
        this.freeHandles();
        // A 429 is refused before anything is created: its own path, never
        // signup.uncertain (flows §0). A resubmit draws a fresh K_master and salt.
        if (failedWith(e, 429))
          return this.pause(
            epoch,
            e as ApiFailure,
            (until) => screen("paused", until),
            () => screen("ready"),
          );
        if (failedWith(e, 409)) return this.set(screen("taken"));
        if (e instanceof ApiFailure && e.code === "SIGNUP_NOT_ALLOWED") {
          return this.set(screen("not-allowed"));
        }
        if (e instanceof NetworkFailure || serverFault(e))
          return this.set({ kind: "signup-uncertain", email });
        if (e instanceof ApiFailure) return this.set(screen("failed"));
        throw e;
      } finally {
        keys.proof.fill(0);
      }
      this.saveSession(session.token, session.expires_at);

      // Step 4: O-open with an empty list. No GET /v1/owner/key: this device holds K_master.
      this.set({
        kind: "albums",
        phase: "ready",
        albums: [],
        create: "closed",
        signingOut: null,
      });
    });
  }

  // ── §3.4 Album list ────────────────────────────────────────────────────

  private saveSession(token: string, expiresAt: string): void {
    this.token = token;
    this.expiresAt = expiresAt;
    this.deps.store.write({ token, expiresAt });
    this.scheduleExpiry();
  }

  private async enterAlbums(epoch: number): Promise<void> {
    this.live(epoch);
    this.set({
      kind: "albums",
      phase: "loading",
      albums: [],
      create: "closed",
      signingOut: null,
    });
    this.scheduleExpiry();
    const token = this.token;
    if (token === null) throw new Stale();
    const list = await this.call(epoch, () => this.api.albums(token));
    const albums = list.albums.map((row) => this.openRow(row));
    this.set({
      kind: "albums",
      phase: "ready",
      albums,
      create: "closed",
      signingOut: null,
    });
  }

  /** A wrapping or title that will not open is shown as failed on its album, never dropped. */
  private openRow(row: AlbumRow): AlbumView {
    const master = this.master;
    if (master === null) throw new Stale();
    const base = { id: row.id, mediaCount: row.media_count };
    const r = this.deps.keys.openAlbumKey(this.deps.envelope, master, row);
    if (!r.ok) {
      if (this.deps.poison.poisoned) throw new EnvelopeUnavailable("trapped");
      return { ...base, title: null, failed: "key" };
    }
    const previous = this.albumKeys.get(row.id);
    if (previous !== undefined) this.freeQuietly(previous);
    this.albumKeys.set(row.id, r.albumKey);
    try {
      const blob = decodeBase64urlRange(row.title, 41, 64 * 1024);
      const title = this.deps.envelope.decryptAlbumTitle(
        r.albumKey,
        uuidToBytes(row.id),
        blob,
      );
      return { ...base, title, failed: null };
    } catch (e) {
      if (e instanceof EnvelopeUnavailable) throw e;
      return { ...base, title: null, failed: "title" };
    }
  }

  // ── §3.5 Create album ──────────────────────────────────────────────────

  openCreate(): void {
    const s = this.state.screen;
    if (s.kind !== "albums" || s.phase !== "ready" || s.create === "creating")
      return;
    this.set({ ...s, create: "open" });
  }

  closeCreate(): void {
    const s = this.state.screen;
    if (s.kind !== "albums" || s.create === "creating") return;
    this.set({ ...s, create: "closed" });
  }

  createAlbum(rawTitle: string): void {
    const s = this.state.screen;
    if (
      s.kind !== "albums" ||
      s.phase !== "ready" ||
      s.create === "closed" ||
      s.create === "creating" ||
      s.signingOut !== null
    )
      return;
    const title = rawTitle.trim();
    if (title === "") return this.set({ ...s, create: "empty" });
    if (codePoints(title) > TITLE_MAX_CODE_POINTS)
      return this.set({ ...s, create: "too-long" });
    const master = this.master;
    const token = this.token;
    if (master === null || token === null) return;
    const epoch = this.epoch;
    this.set({ ...s, create: "creating" });

    this.guarded(epoch, async () => {
      const failed = (): void => {
        const now = this.state.screen;
        if (now.kind === "albums") this.set({ ...now, create: "failed" });
      };
      const id = this.deps.newAlbumId();
      const k = this.deps.keys.createAlbumKey(this.deps.envelope, master, id);
      if (!k.ok) {
        if (this.deps.poison.poisoned) throw new EnvelopeUnavailable("trapped");
        return failed();
      }
      let blob: Uint8Array;
      try {
        blob = this.deps.envelope.encryptAlbumTitle(
          k.albumKey,
          uuidToBytes(id),
          title,
        );
      } catch (e) {
        this.freeQuietly(k.albumKey);
        if (e instanceof EnvelopeUnavailable) throw e;
        return failed();
      }
      try {
        // Network loss and 5xx are retried inside call(), with the same id and body.
        await this.call(epoch, () =>
          this.api.createAlbum(token, {
            id,
            title: blob,
            wrappedKey: k.wrappedKey,
            wrapNonce: k.wrapNonce,
          }),
        );
      } catch (e) {
        // 409 is a lost response to our own create: treat it as created (api-sketch §9.2).
        if (!failedWith(e, 409)) {
          this.freeQuietly(k.albumKey);
          if (e instanceof Stale) throw e;
          if (e instanceof ApiFailure) return failed();
          throw e;
        }
      }
      if (this.dead || epoch !== this.epoch) {
        this.freeQuietly(k.albumKey);
        return;
      }
      this.albumKeys.set(id, k.albumKey);
      const now = this.state.screen;
      if (now.kind !== "albums") return;
      // Newest first, as GET /v1/albums orders them.
      this.set({
        ...now,
        albums: [{ id, mediaCount: 0, title, failed: null }, ...now.albums],
        create: "closed",
      });
    });
  }

  // ── §3.4 The owner's album, §3.6 upload, §3.7 remove (album.ts) ─────────

  /** From the list. An album whose key would not open cannot be opened; one whose title would not still can. */
  openAlbum(id: string): void {
    const s = this.state.screen;
    if (
      s.kind !== "albums" ||
      s.phase !== "ready" ||
      s.signingOut !== null ||
      s.create === "creating"
    )
      return;
    this.enterAlbum(id);
  }

  /** The album's screen, fetched afresh: from the list, and back from its invite or people screens. */
  private enterAlbum(id: string): void {
    const view = this.albumList.find((a) => a.id === id);
    const albumKey = this.albumKeys.get(id);
    const token = this.token;
    if (
      view === undefined ||
      view.failed === "key" ||
      albumKey === undefined ||
      token === null
    )
      return;
    const epoch = this.epoch;
    const d = this.deps;
    this.closeAlbum();
    const album: OwnerAlbum = new OwnerAlbum(
      {
        api: this.api,
        token,
        envelope: d.envelope,
        albumKey,
        imaging: d.imaging,
        decodeImage: d.decodeImage,
        preview: d.preview,
        newMediaId: d.newMediaId,
        now: d.now,
        sleep: d.sleep,
        nextFrames: d.nextFrames,
        setTimer: d.setTimer,
        // Each attempt checks the album is still open, so a request waiting out offline or a 429 is not resent after leaving.
        call: <T>(op: () => Promise<T>): Promise<T> =>
          this.call(
            epoch,
            (): Promise<T> =>
              this.album === album ? op() : Promise.reject(new Stale()),
          ),
        isStale: (e) => e instanceof Stale,
        guarded: (task) => this.guarded(epoch, task),
        screen: () =>
          this.state.screen.kind === "album" ? this.state.screen : null,
        show: (screen) => this.set(screen),
        gone: () => this.leaveAlbum(true),
      },
      id,
    );
    this.album = album;
    this.set({
      kind: "album",
      id,
      title: view.title,
      phase: "loading",
      items: [],
      viewer: null,
      confirm: null,
      review: null,
      chooseRefused: false,
      erasurePending: 0,
      leaving: false,
    });
    album.start();
  }

  /**
   * Back to the list. With a photo still on its way, ask first: leaving stops
   * it, and what it leaves on the server shows as pending or failed (flows §3.6).
   */
  leaveAlbum(force = false): void {
    const s = this.state.screen;
    const a = this.album;
    if (s.kind !== "album" || a === null || s.confirm?.removing === true)
      return;
    if (a.busy && !force) {
      this.afterLeave = null;
      return a.askLeave(true);
    }
    const count = s.items.filter((i) => i.status !== null).length;
    this.albumList = this.albumList.map((v) =>
      v.id === s.id ? { ...v, mediaCount: count } : v,
    );
    const next = this.afterLeave;
    this.afterLeave = null;
    if (next === "invite") return this.enterInvite(s.id, s.title);
    if (next === "people") return this.enterPeople(s.id, s.title);
    this.closeAlbum();
    this.set({
      kind: "albums",
      phase: "ready",
      albums: this.albumList,
      create: "closed",
      signingOut: null,
    });
  }

  /** Every album action goes to the open album, and only while its screen is showing. */
  private inAlbum(f: (a: OwnerAlbum) => void): void {
    const a = this.album;
    if (a === null || this.state.screen.kind !== "album") return;
    try {
      f(a);
    } catch (e) {
      if (e instanceof EnvelopeUnavailable || this.deps.poison.poisoned)
        return this.deviceFailed();
      // The album was left underneath the call: nothing to do. Anything else is a bug, and surfaces.
      if (!(e instanceof AlbumLeft || e instanceof Stale)) throw e;
    }
  }

  stayInAlbum(): void {
    this.afterLeave = null;
    this.inAlbum((a) => a.askLeave(false));
  }
  /** Opens the review (flows §3.6): nothing is prepared or sent until sendReview. */
  choosePhotos(files: readonly File[]): void {
    this.inAlbum((a) => a.choose(files));
  }
  setCaption(key: string, caption: string): void {
    this.inAlbum((a) => a.setCaption(key, caption));
  }
  unpickPhoto(key: string): void {
    this.inAlbum((a) => a.unpick(key));
  }
  cancelReview(): void {
    this.inAlbum((a) => a.cancelReview());
  }
  sendReview(): void {
    this.inAlbum((a) => a.sendReview());
  }
  resendPhoto(key: string): void {
    this.inAlbum((a) => a.resend(key));
  }
  dismissPhoto(key: string): void {
    this.inAlbum((a) => a.dismiss(key));
  }
  retryThumb(key: string): void {
    this.inAlbum((a) => a.retryThumb(key));
  }
  openViewer(key: string): void {
    this.inAlbum((a) => a.openViewer(key));
  }
  closeViewer(): void {
    this.inAlbum((a) => a.closeViewer());
  }
  askRemove(key: string): void {
    this.inAlbum((a) => a.askRemove(key));
  }
  cancelRemove(): void {
    this.inAlbum((a) => a.cancelRemove());
  }
  confirmRemove(): void {
    this.inAlbum((a) => a.confirmRemove());
  }

  // ── §3.8 Create invite (invite.ts) ─────────────────────────────────────

  /** From the album. With a photo still on its way, ask first, as leaving for the list does. */
  openInvite(): void {
    this.leaveAlbumFor("invite");
  }

  /** From the album: its recipients, revoke, and the access log. */
  openPeople(): void {
    this.leaveAlbumFor("people");
  }

  private leaveAlbumFor(next: "invite" | "people"): void {
    const s = this.state.screen;
    const a = this.album;
    if (
      s.kind !== "album" ||
      a === null ||
      s.phase !== "ready" ||
      s.confirm !== null ||
      s.viewer !== null ||
      s.review !== null
    )
      return;
    if (a.busy) {
      this.afterLeave = next;
      return a.askLeave(true);
    }
    this.afterLeave = next;
    this.leaveAlbum(true);
  }

  /** The guarded runner for a sub-screen: a task that finds its screen gone simply stops. */
  private subGuarded(epoch: number, task: () => Promise<void>): void {
    this.guarded(epoch, () =>
      task().catch((e: unknown) => {
        if (
          e instanceof InviteLeft ||
          e instanceof PeopleLeft ||
          e instanceof AlbumLeft
        )
          return;
        throw e;
      }),
    );
  }

  private enterInvite(albumId: string, albumTitle: string | null): void {
    const albumKey = this.albumKeys.get(albumId);
    const token = this.token;
    if (albumKey === undefined || token === null) return;
    this.closeAlbum();
    const epoch = this.epoch;
    const d = this.deps;
    const flow: InviteFlow = new InviteFlow({
      api: this.api,
      token,
      envelope: d.envelope,
      albumKey,
      albumId,
      albumTitle,
      keys: {
        createQrInvite: d.keys.createQrInvite,
        createPassphraseInvite: d.keys.createPassphraseInvite,
      },
      loadWordlists: d.loadWordlists,
      displayLanguage: d.displayLanguage,
      origin: d.origin,
      nextFrames: d.nextFrames,
      call: <T>(op: () => Promise<T>): Promise<T> =>
        this.call(
          epoch,
          (): Promise<T> =>
            this.invite === flow ? op() : Promise.reject(new Stale()),
        ),
      isStale: (e) => e instanceof Stale,
      guarded: (task) => this.subGuarded(epoch, task),
      poisoned: () => d.poison.poisoned,
      screen: () =>
        this.invite === flow && this.state.screen.kind === "invite"
          ? this.state.screen
          : null,
      show: (screen) => {
        if (this.invite === flow) this.set(screen);
      },
      gone: () => this.backToList(),
    });
    this.invite = flow;
    flow.start();
  }

  private inInvite(f: (i: InviteFlow) => void): void {
    const i = this.invite;
    if (i === null || this.state.screen.kind !== "invite") return;
    try {
      f(i);
    } catch (e) {
      if (!(e instanceof InviteLeft)) throw e;
    }
  }

  chooseInviteMode(mode: InviteMode): void {
    this.inInvite((i) => i.chooseMode(mode));
  }
  chooseInviteLanguage(language: string): void {
    this.inInvite((i) => i.chooseLanguage(language));
  }
  retryInviteLanguages(): void {
    this.inInvite((i) => i.retryLanguages());
  }
  createInvite(label: string): void {
    this.inInvite((i) => i.create(label));
  }
  /** On the share step: open or close the "this link cannot be shown again" confirmation. */
  askLeaveInvite(open: boolean): void {
    this.inInvite((i) => i.askLeave(open));
  }

  /**
   * Back to the album. From the form, at once. Never during the derivation
   * wait or the create. From the share step only once confirmed (`force`):
   * the link, the words and the QR go with the screen, and nothing keeps them.
   */
  leaveInvite(force = false): void {
    const s = this.state.screen;
    const i = this.invite;
    if (s.kind !== "invite" || i === null || i.busy) return;
    if (i.sharing && !force) return i.askLeave(true);
    if (i.sharing && !s.leaving) return;
    this.closeAlbum();
    this.enterAlbum(s.albumId);
  }

  // ── §3.9 Recipients and revoke, §3.10 Access log (people.ts) ───────────

  private enterPeople(albumId: string, albumTitle: string | null): void {
    const albumKey = this.albumKeys.get(albumId);
    const token = this.token;
    if (albumKey === undefined || token === null) return;
    this.closeAlbum();
    const epoch = this.epoch;
    const d = this.deps;
    const people: AlbumPeople = new AlbumPeople({
      api: this.api,
      token,
      envelope: d.envelope,
      albumKey,
      albumId,
      albumTitle,
      decodeImage: d.decodeImage,
      call: <T>(op: () => Promise<T>): Promise<T> =>
        this.call(
          epoch,
          (): Promise<T> =>
            this.people === people ? op() : Promise.reject(new Stale()),
        ),
      isStale: (e) => e instanceof Stale,
      guarded: (task) => this.subGuarded(epoch, task),
      screen: () => {
        const sc = this.state.screen;
        return this.people === people &&
          (sc.kind === "people" || sc.kind === "log")
          ? sc
          : null;
      },
      show: (screen) => {
        if (this.people === people) this.set(screen);
      },
      gone: () => this.backToList(),
    });
    this.people = people;
    people.start();
  }

  private inPeople(f: (p: AlbumPeople) => void): void {
    const p = this.people;
    const k = this.state.screen.kind;
    if (p === null || (k !== "people" && k !== "log")) return;
    try {
      f(p);
    } catch (e) {
      if (e instanceof EnvelopeUnavailable || this.deps.poison.poisoned)
        return this.deviceFailed();
      if (!(e instanceof PeopleLeft)) throw e;
    }
  }

  askRevoke(id: string): void {
    this.inPeople((p) => p.askRevoke(id));
  }
  cancelRevoke(): void {
    this.inPeople((p) => p.cancelRevoke());
  }
  confirmRevoke(): void {
    this.inPeople((p) => p.confirmRevoke());
  }
  openLog(recipientId: string | null): void {
    this.inPeople((p) => p.openLog(recipientId));
  }
  moreLog(): void {
    this.inPeople((p) => p.moreLog());
  }
  closeLog(): void {
    this.inPeople((p) => p.closeLogView());
  }

  /** Back to the album from the people screen. Not while a revoke is in flight. */
  leavePeople(): void {
    const s = this.state.screen;
    if (s.kind !== "people" || s.revoke?.busy === true) return;
    this.closeAlbum();
    this.enterAlbum(s.albumId);
  }

  /** The album answered 404 from a sub-screen: it is gone, so back to the list. */
  private backToList(): void {
    this.closeAlbum();
    this.set({
      kind: "albums",
      phase: "ready",
      albums: this.albumList,
      create: "closed",
      signingOut: null,
    });
  }

  // ── §3.11 Logout ───────────────────────────────────────────────────────

  /** Unlock's sign-out: ask first, for a shared device or the wrong account. */
  askUnlockSignOut(open: boolean): void {
    const s = this.state.screen;
    if (s.kind !== "unlock" || s.phase === "deriving") return;
    this.set({ ...s, signingOut: open });
  }

  /**
   * Free every handle first, then call the route, then clear storage
   * (flows §3.11). If the call fails, the keys are already gone and the token
   * is kept only so the call can be retried.
   */
  logout(scope: LogoutScope): void {
    const s = this.state.screen;
    const fromUnlock = s.kind === "unlock" && s.signingOut;
    const fromAlbums =
      s.kind === "albums" && s.signingOut === null && s.create !== "creating";
    const fromPartial = s.kind === "signed-out-partial" && !s.retrying;
    if ((!fromUnlock && !fromAlbums && !fromPartial) || this.logoutInFlight)
      return;
    const token = this.token;
    if (token === null) return this.toSignin("signed-out");

    this.bumpEpoch(); // nothing in flight may resume into a session being ended
    this.freeHandles();
    this.material = null;
    this.emit({ offline: false, rateLimited: false, expiry: null });
    if (s.kind === "albums") this.set({ ...s, signingOut: scope });
    else if (s.kind === "signed-out-partial")
      this.set({ ...s, retrying: true });
    else this.set({ kind: "unlock", phase: "ready", signingOut: true });

    const epoch = this.epoch;
    const route =
      scope === "device"
        ? () => this.api.logout(token)
        : () => this.api.logoutAll(token);
    this.logoutInFlight = true;
    void route().then(
      () => {
        this.logoutInFlight = false;
        if (epoch === this.epoch && !this.dead) this.toSignin("signed-out");
      },
      (e: unknown) => {
        this.logoutInFlight = false;
        if (epoch !== this.epoch || this.dead) return;
        // 401: the session had already ended. Signed out either way.
        if (failedWith(e, 401)) return this.toSignin("signed-out");
        this.set({ kind: "signed-out-partial", scope, retrying: false });
      },
    );
  }

  /** From the partial state: leave anyway. Storage is cleared; the server session lapses on its own. */
  leaveAfterPartial(): void {
    if (this.state.screen.kind !== "signed-out-partial") return;
    this.toSignin("signed-out");
  }

  // ── §3.12 Session expiry ───────────────────────────────────────────────

  private scheduleExpiry(): void {
    this.cancelExpiry?.();
    this.cancelExpiry = null;
    const at = this.expiresAt === null ? NaN : Date.parse(this.expiresAt);
    if (Number.isNaN(at)) return this.emit({ expiry: null });
    const endsAt = new Date(at);
    // The device's clock against server time: a courtesy, not the authority.
    // The 401 is the authority.
    const check = (): void => {
      const until = at - EXPIRY_WARNING_MS - this.deps.now().getTime();
      if (until <= 0) {
        this.cancelExpiry = null;
        this.emit({ expiry: { endsAt, ending: true } });
        return;
      }
      this.emit({ expiry: { endsAt, ending: false } });
      this.cancelExpiry = this.deps.setTimer(
        Math.min(until, MAX_TIMER_MS),
        check,
      );
    };
    check();
  }
}
