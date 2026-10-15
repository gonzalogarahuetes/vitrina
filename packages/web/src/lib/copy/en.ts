/*
 * English copy for the recipient path, keyed by slot name: the ⟦copy: …⟧ slots
 * of flows §2 and §4, the prototype's extra slots, and open.newer-version.
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
} as const;

export type Copy = typeof en;

/** The watermark's date: "6 Aug 2026", as brief §5's example. */
export function watermarkDate(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(d);
}
