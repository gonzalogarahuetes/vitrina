/*
 * English copy, keyed by slot name. Recipient path: the ⟦copy: …⟧ slots of
 * flows §2 and §4, the prototype's extra slots, and open.newer-version. Owner
 * path: the slots of flows §3.1–§3.5, §3.11 and §3.12, the Main (unlock),
 * Signup and Signin boards' extra slots, and signin.unavailable. Each owner
 * slot carries its rule above it.
 *
 * Every string here is bound by brief §3's never-claim list: nothing may say or
 * suggest that screenshots are prevented, that photos cannot be copied, or that
 * anything is "protected", "secure" or "private forever". Other languages are
 * gated on a fluent reader (brief §15.3) and do not exist yet.
 *
 * Drafts awaiting the owner's review, except `onboarding.text`, which is brief
 * §16 verbatim and must not be edited here.
 */

export const en = {
  /** Brief §16, verbatim. Its third paragraph is the house-key presentation. */
  "onboarding.text": [
    "Someone has opened a window to share something with you: you have been given access to an album of their choice, and you can visit it as many times as you want.",
    "Nothing is automatically saved to your phone or laptop. There is no file to forward. Pictures are unreadable on our servers.",
    "The link is the key: keep it to yourself. Screenshots leave marks, and all invitations are revocable.",
  ],
  "onboarding.continue": "Open the album",

  "open.loading": "Opening the album…",
  "open.newer-version": "This invitation was made for a newer version of this app, so it can't be opened here. Ask the person who sent it.",

  "derive.wait": "Unlocking on this device. This can take a few seconds.",
  "derive.failed": "This device couldn't finish opening the album. Open your invitation link again to try once more, or use another phone or computer.",

  "recipient.passphrase.title": "Enter your passphrase",
  "recipient.passphrase.label": "The person who invited you gave you some words to go with this link. Type them in order.",
  "recipient.passphrase.word": (n: number) => `Word ${n}`,
  "recipient.passphrase.submit": "Open the album",
  "pass.entry": "Capitals and accents don't matter.",
  "pass.empty": "Type the words of your passphrase first.",
  "pass.wrong": "Those words don't open this album. Check each word and try again.",
  "pass.lost": "Lost the passphrase? Nobody can recover it, but the person who invited you can send you a new invitation.",

  "grid.empty": "There are no photos here yet. Open your invitation link again later to look.",
  "grid.photo.a11y": (i: number, n: number) => `Photo ${i} of ${n}. Opens larger.`,
  "grid.cell.loading.a11y": (i: number, n: number) => `Photo ${i} of ${n}, loading`,
  "grid.cell.failed": "Couldn't load. Tap to try again.",
  /** Its metadata is unusable, so retrying cannot help. */
  "grid.cell.unavailable": "This photo can't be shown.",

  /** Drawn into the pixels, two lines. Social, not forensic: names, never identifies or traces. */
  watermark: (label: string, date: string) => [`Shared with ${label}`, date] as const,

  "viewer.back": "Back to album",
  "viewer.back-to-album": "Back to album",
  "viewer.photo.a11y": (i: number, n: number) => `Photo ${i} of ${n}`,
  "viewer.loading": "Loading the full photo…",
  "viewer.zoom-in": "Zoom in",
  "viewer.zoom-out": "Zoom out",
  "viewer.pan-up": "Move up",
  "viewer.pan-down": "Move down",
  "viewer.pan-left": "Move left",
  "viewer.pan-right": "Move right",
  "viewer.fit": "Fit",
  "viewer.removed": "This photo is no longer in this album.",
  "viewer.failed": "This photo couldn't be shown on this device.",

  revoked: "This album is no longer shared with you. The person who invited you can tell you more.",
  notrecognised: "This invitation doesn't work. Ask the person who sent it to check it, or to send you a new one.",
  dead: "Open your invitation link again to see the album.",

  offline: "Can't reach the album right now. Check your connection, then try again.",
  "offline.retry": "Try again",

  // ── Owner path (flows §3) ─────────────────────────────────────────────────
  // Owner-wide rules: nothing says or implies the password is "erased" or
  // "wiped" after use, because it is a JavaScript string and cannot be
  // (api-sketch §8.4). Nothing suggests that attempts are counted.

  /** Flows §2, for the owner: this device could not finish. Not a wrong password (brief §11). Its remedy is a reload. */
  "derive.failed.owner": "This device couldn't finish unlocking. Reload the page to try again, or use another phone or computer.",
  "derive.failed.retry": "Reload and try again",

  /** Page load with a token, before GET /v1/owner/key answers. No rule beyond brief §3. */
  "owner.checking": "Checking this device…",
  /** Flows §0, for the owner. Changes nothing; retry. */
  "offline.owner": "Can't reach Vitrina right now. Check your connection, then try again.",
  /** A 429's Retry-After. Must not suggest attempts on the account are counted: the limit is per network. */
  "wait.rate-limited": "Waiting a moment before trying again.",
  "password.show": "Show password",
  "password.hide": "Hide password",

  /** Flows §3.1, decided: "Unlock" and no address, because no email is stored. */
  "unlock.prompt": "Unlock",
  "unlock.password.label": "Password",
  "unlock.submit": "Unlock",
  "unlock.empty": "Type your password first.",
  /** Flows §3.1: must not suggest attempts are counted or that the account will lock. Nothing counts them. */
  "unlock.wrong": "That password doesn't unlock this account. Check it and try again.",
  /** The wrapping from GET /v1/owner/key could not be used: a service problem, not the password. */
  "unlock.unavailable": "This device couldn't get what it needs to unlock. Try again in a moment.",
  "unlock.retry": "Try again",
  /** Flows §3.1: offered for a shared device or the wrong account. */
  "unlock.signout": "Sign out",
  "unlock.signout.confirm": "Sign out on this device?",
  "unlock.signout.consequence": "To come back, you'll sign in with your email address and password.",
  "unlock.signout.yes": "Sign out",
  "unlock.signout.no": "Cancel",

  "signin.title": "Sign in",
  "signin.email.label": "Email address",
  "signin.password.label": "Password",
  "signin.submit": "Sign in",
  "signin.busy": "Signing in…",
  /** Flows §3.3, api-sketch §4.3: must not say which half was wrong. */
  "signin.failed": "The email address or password isn't right. Check both and try again.",
  /**
   * Decided 15 October 2026: a service problem with a retry. Worded unlike
   * derive.failed and signin.failed, and says nothing about whether the
   * address has an account.
   */
  "signin.unavailable": "Sign-in isn't working right now. Try again in a moment.",
  "signin.retry": "Try again",
  /** Flows §3.3: signed in, but this account's key would not open. Not a password error. */
  "signin.cannot-unlock": "Your password was accepted, but this account's albums couldn't be opened on this device. This isn't a problem with your password.",
  "signin.back": "Back to sign in",
  "signin.to-signup": "New here? Create an account",
  /** Flows §3.12: signed out because the session ended. Must not suggest something went wrong. */
  "session.ended": "Your session ended, so you've been signed out. Sign in again to carry on.",
  "signed-out": "You're signed out on this device.",

  "signup.title": "Create your account",
  "signup.email.label": "Email address",
  "signup.password.label": "Choose a password",
  /** Flows §3.2, brief §12: a length floor and a blocklist, with no composition rules. */
  "signup.policy": "At least 12 characters, and any characters you like. A few words strung together work well. Very common passwords aren't accepted.",
  "signup.too-short": "Use at least 12 characters.",
  "signup.too-long": "Use 256 characters or fewer.",
  "signup.common": "That password is too common. Choose another.",
  "signup.invalid": "That password contains a character this app can't use. Type it again.",
  /** Flows §3.2, brief §11: forgetting the password loses every album, and no reset recovers them. Shown before submission. */
  "signup.loss": "If you forget this password, you lose every album in this account. There is no reset, and nobody can recover them, not even us.",
  "signup.submit": "Create account",
  "signup.busy": "Creating your account…",
  /** Flows §3.2: must not claim that account existence is private (brief §11). */
  "signup.taken": "There's already an account with this email address. If it's yours, sign in.",
  "signup.taken.signin": "Sign in",
  /** Flows §3.2: the account may have been created. Sign in to find out. */
  "signup.uncertain": "We couldn't tell whether your account was created. Sign in with the same email address and password to find out.",
  "signup.uncertain.signin": "Sign in",
  /** A 400, 413 or 415: a client build error (api-sketch §7.5). Generic. */
  "signup.failed": "Your account couldn't be created. Try again later.",
  "signup.to-signin": "Already have an account? Sign in",

  "albums.title": "Your albums",
  "albums.loading": "Opening your albums…",
  /** Flows §3.4: no rule beyond brief §3. */
  "albums.empty": "You have no albums yet.",
  /** Flows §3.4, api-sketch §9.2: items, not photos. */
  "albums.count": (n: number) => (n === 1 ? "1 item" : `${n} items`),
  /** Flows §3.4: a wrapping that will not open, shown on its album. */
  "albums.failed.key": "This album couldn't be opened on this device.",
  /** Flows §3.4: a title that will not open, shown on its album. */
  "albums.failed.title": "This album's name couldn't be read on this device.",

  "album.create": "New album",
  "album.title.label": "Album name",
  /** Flows §3.5: may say the relay cannot read the title (api-sketch §5.3). Nothing stronger. */
  "album.title": "Our servers can't read this name.",
  "album.title.empty": "Give the album a name.",
  "album.title.too-long": "Use 200 characters or fewer.",
  "album.create.submit": "Create album",
  "album.create.cancel": "Cancel",
  "album.create.busy": "Creating the album…",
  "album.create.failed": "The album couldn't be created. Try again.",

  /** Flows §3.11. */
  "logout.device": "Sign out on this device",
  /** Flows §3.11, api-sketch §7.5: ends every session, including this one. */
  "logout.everywhere": "Sign out everywhere, this device included",
  "logout.busy": "Signing out…",
  /** Flows §3.11: the keys are gone from this device; the server session may still be live until it expires. */
  "logout.partial": (everywhere: boolean) =>
    everywhere
      ? "Your album keys are gone from this device, but the server couldn't be told to end your sessions. They stay valid until they expire, on this device and any other."
      : "Your album keys are gone from this device, but the server couldn't be told to end this session. It stays valid until it expires.",
  "logout.retry": "Try again",
  "logout.leave": "Leave anyway",

  /** Flows §3.12: when the session ends, and that uploads still running then will be lost. */
  "session.ending": (when: string) => `Your session ends ${when}. Anything still uploading at that point will be lost.`,
} as const;

export type Copy = typeof en;

/** The watermark's date: "6 Aug 2026", as brief §5's example. */
export function watermarkDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(d);
}

/** When a session ends, for session.ending: "Thu 29 Oct, 12:00", in the device's time zone. */
export function sessionEndTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}
