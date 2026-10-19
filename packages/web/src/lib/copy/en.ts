/*
 * English copy, keyed by slot name. Recipient path: the ⟦copy: …⟧ slots of
 * flows §2 and §4, the prototype's extra slots, and open.newer-version. Owner
 * path: the slots of flows §3.1–§3.7, §3.11 and §3.12, the Main (unlock),
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
  /** A 429's Retry-After on a token route, waited out in place. Must not suggest attempts on the account are counted. */
  "wait.rate-limited": "Waiting a moment before trying again.",
  /**
   * flows §0, a 429 on a credential route: the form is back, the password
   * field is empty, and submitting resumes when the countdown ends. Says
   * "this network", because the limit is per IP (api-sketch §7.6). Never the
   * account, and never that attempts are counted.
   */
  "credential.paused": (when: string) => `This network has to pause before signing in or signing up again. You can try again in ${when}.`,
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

  "albums.open.a11y": (title: string) => `Open ${title}`,
  "albums.open.untitled.a11y": "Open this album",

  // ── The owner's album (flows §3.4, §3.6, §3.7) ────────────────────────────
  // Album-wide rules: an item is "done" only on the server's ready (api-sketch
  // §9.7), so nothing says "uploaded" before it. Nothing claims a photo cannot
  // be copied (brief §3). Failures carry no reason string (api-sketch §9.8).

  "album.loading": "Opening the album…",
  "album.back": "Back to your albums",
  /** Flows §3.4: no rule beyond brief §3. */
  "album.empty": "No photos in this album yet.",
  "album.add": "Add photos",
  /** Flows §3.6, brief §3 "We promise": may say location and camera details are removed before anything leaves the device. */
  "upload.stripped": "Location and camera details are removed on this device before anything is sent.",
  /** Flows §3.6, #14: may say a viewing-size copy is sent. Must not claim this prevents copying (brief §3). */
  "upload.downscale": "A viewing-size copy of each photo is sent, not the original file.",
  "album.photo.a11y": (i: number, n: number) => `Photo ${i} of ${n}. Opens larger.`,

  // Per item, while this device moves it (flows §3.6's drawn states).
  "upload.queued": "Waiting its turn",
  "upload.preparing": "Preparing on this device…",
  "upload.encrypting": "Encrypting…",
  "upload.uploading": "Sending…",
  /** Sent; not done until the server says ready (#9). */
  "upload.waiting": "Waiting for the server to confirm…",

  // Per item, as the server reports it.
  /** pending, not on this device and not yet old: started somewhere and not finished. */
  "media.pending": "Started, not finished yet",
  "media.processing": "Still arriving",
  /** Flows §3.6 upload.failed: retry or remove, no reason string (api-sketch §9.8). This tab still holds it. */
  "upload.failed": "This photo didn't finish uploading. Send it again, or remove it.",
  /** The same, after a reload: nothing is left to re-send (flows §3.6), so the remedy is removal. */
  "upload.failed.gone": "This photo didn't finish uploading. Remove it, then add it again.",
  /**
   * Flows §3.4 album.stalled and §3.6 upload.stalled: states how long the item
   * has been stuck and offers removal. No guess at the cause (api-sketch §9.8).
   */
  "upload.stalled": (howLong: string, since: string) => `This photo has been stuck for ${howLong}, since ${since}. You can remove it.`,
  "upload.resend": "Send again",

  // Failed on this device: nothing about it was sent.
  /** #17: stripping could not be confirmed, so it was not sent. Says what was not sent, not why the check failed. */
  "upload.not-stripped": "This photo wasn't sent: this device couldn't confirm its location and camera details were removed.",
  "upload.not-prepared": "This photo couldn't be prepared on this device, so nothing was sent.",
  "upload.refused": "The server didn't accept this photo, so nothing was stored.",
  "upload.dismiss": "Dismiss",

  "album.leaving": "A photo is still being added. If you leave now, it stops, and anything already sent shows here as unfinished.",
  "album.leaving.go": "Leave anyway",
  "album.leaving.stay": "Stay",

  "media.remove": "Remove",
  "remove.title": "Remove this photo?",
  "remove.checking": "Checking when this album was last opened…",
  /** Flows §3.7: never ready, so nobody could have retrieved it. */
  "remove.never-ready": "It never finished uploading, so nobody could have opened it.",
  /** Flows §3.7: conveys exactly this. Uses "opened" only (api-sketch §11.6). */
  "remove.unopened": "No one has opened this album since you added it.",
  /** Flows §3.7: stops future access only. Must not imply that what was retrieved is withdrawn (brief §8). */
  "remove.opened": "Removing it stops anyone opening it from now on. It can't undo anything someone has already seen.",
  "remove.confirm": "Remove",
  "remove.cancel": "Keep it",
  "remove.busy": "Removing…",
  /**
   * Flows §3.7 remove.pending: hidden from everyone now; its stored copy has
   * not been erased yet. Must not promise when or whether erasure completes,
   * say "under way", or imply anything runs after this screen closes.
   */
  "remove.pending": (n: number) =>
    n === 1
      ? "A photo you removed is hidden from everyone now. Its stored copy hasn't been erased yet."
      : `${n} photos you removed are hidden from everyone now. Their stored copies haven't been erased yet.`,

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

/** For upload.stalled: "about 3 hours", "about 1 day". Rounded, never below a minute. */
export function stuckFor(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? "about a minute" : `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "about an hour" : `about ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "about a day" : `about ${days} days`;
}

/** For upload.stalled: "14:05" today, otherwise "Thu 15 Oct, 14:05", in the device's time zone. */
export function stuckSince(d: Date, now: Date): string {
  const sameDay = d.toDateString() === now.toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay ? { hour: "2-digit", minute: "2-digit" } : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-GB", opts).format(d);
}

/** The countdown for credential.paused: "about 12 minutes", "45 seconds". Rounded up, never "0". */
export function pauseLeft(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}
