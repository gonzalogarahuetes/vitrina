/*
 * English copy, keyed by slot name. Recipient path: the ⟦copy: …⟧ slots of
 * flows §2 and §4, the prototype's extra slots, and open.newer-version. Owner
 * path: the slots of flows §3.1–§3.7, §3.11 and §3.12, the Main (unlock),
 * Signup and Signin boards' extra slots, and signin.unavailable; flows §3.8–
 * §3.10's invite, revoke and access-log slots, with the Invite board's extra
 * ones. Each owner slot carries its rule above it.
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

  /** Drawn into the pixels, one short line in a corner. Social, not forensic: names, never identifies or traces. */
  watermark: (label: string, date: string) => `${label} · ${date}`,

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

  // The review, between choosing photos and sending them (flows §3.6, before step 1).
  "upload.review.title": (n: number) => (n === 1 ? "1 photo chosen" : `${n} photos chosen`),
  /** True by construction: nothing is prepared or requested before Send. */
  "upload.review.intro": "Nothing is sent until you press Send. Take out any photo you didn't mean to choose.",
  "upload.review.preview.a11y": (name: string) => `Preview of ${name}`,
  "upload.review.preview.loading.a11y": (name: string) => `Preview of ${name}, loading`,
  "upload.review.preview.failed": "No preview on this device",
  /** Its bytes could not be read when chosen: the remedy is choosing it again. */
  "upload.review.unreadable": "This photo couldn't be read. Pick it again.",
  /** A choice over the cap on originals held at once (album.ts ORIGINALS_CAP). */
  "upload.too-large": "Those photos are too large to add together. Choose fewer photos at a time.",
  "upload.review.caption.label": "Caption (optional)",
  /** May say the server can't read it. Nothing stronger (brief §3). */
  "upload.review.caption.hint": "Shown below the photo. Our servers can't read it.",
  /** Counted in characters as a person counts them (code points, as the password policy is). */
  "upload.review.caption.count": (n: number) => `${n} of 280 characters`,
  "upload.review.caption.too-long": "Use 280 characters or fewer.",
  "upload.review.caption.invalid": "This caption has a character that can't be saved. Try typing it again.",
  "upload.review.remove": "Take out",
  "upload.review.remove.a11y": (name: string) => `Take out ${name}`,
  "upload.review.send": (n: number) => (n === 1 ? "Send 1 photo" : `Send ${n} photos`),
  "upload.review.cancel": "Cancel",

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

  // ── Invites (flows §3.8) ──────────────────────────────────────────────────
  // Invite-wide rules: an invitation is a bearer credential for the whole
  // album (brief §11), so nothing here may suggest it cannot be passed on, and
  // every QR and link carries the house-key line. Neither mode is presented as
  // stronger in every respect (encryption spec §6.5): each says what it gives
  // and what it costs. Every string is a whole sentence on its own, for the
  // Spanish interface to come; nothing is assembled from fragments.

  /** From the album. No rule beyond brief §3. */
  "album.invite": "Invite someone",
  /** From the album: flows §3.9's list. */
  "album.people": "Invited people",

  "invite.title": "Invite someone to this album",
  "invite.back": "Back to the album",
  /** Flows §3.8 step 2: the name the watermark carries (brief §5). */
  "invite.name.label": "Their name",
  /** Brief §5: the watermark is social, never "tracking". May say the relay can't read it (api-sketch §5.3), nothing stronger. */
  "invite.name.hint": "It's written in a corner of every photo they open, with the date, like this: María · 6 Aug 2026. Our servers can't read it.",
  "invite.name.empty": "Write their name first.",
  "invite.name.too-long": "Use 60 characters or fewer.",
  /** ⟦copy: invite.mode⟧ — neither mode is stronger in every respect (encryption spec §6.5). QR first, as the default. */
  "invite.mode": "How will you give them the invitation?",
  "invite.mode.qr": "A QR code or link",
  /** §6.5: direct mode is stronger against stolen server data. */
  "invite.mode.qr.gives": "One thing to send: they scan the code or tap the link. If the data on our servers were ever stolen, it couldn't be used to open this album.",
  /** §6.5, brief §11: whoever holds or photographs it has full access until revoked. */
  "invite.mode.qr.costs": "Anyone who gets hold of it, even a photo of the code, can open the album until you revoke it.",
  "invite.mode.passphrase": "A link and a passphrase",
  /** §6.5: the link alone opens nothing. */
  "invite.mode.passphrase.gives": "The link alone opens nothing. They also need a few words, which you read out to them or write down.",
  /** §6.5: weaker against stolen server data; more steps for the recipient. */
  "invite.mode.passphrase.costs": "More steps for them, because they type the words in. And if the data on our servers were ever stolen, this kind of invitation could be attacked by guessing, which a QR code's cannot.",
  /** ⟦copy: invite.language⟧ — the passphrase language is the recipient's, not the app's (brief §15.2). */
  "invite.language": "Language of the passphrase",
  "invite.language.hint": "Choose a language they speak, so the words are easy for them to say and type. It doesn't have to be the language of this app.",
  "invite.language.loading": "Loading the word lists…",
  "invite.language.failed": "The word lists couldn't be loaded. Check your connection, then try again.",
  "invite.language.retry": "Try again",
  /** No vetted list exists (encryption spec §6.3): passphrase mode cannot be offered, and says so. */
  "invite.language.none": "Passphrase invitations aren't available in this version of the app. Use a QR code or link instead.",
  "invite.language.choose": "Choose a language for the passphrase first.",
  "invite.create": "Create the invitation",
  "invite.creating": "Creating the invitation…",
  /** A 400, 413 or 415, or repeated 409s. Nothing was shared, and the screen says so. */
  "invite.failed": "The invitation couldn't be created, and nothing was shared. Try again.",
  /** Flows §2's third exit, for an invite: this device could not finish. Never a wrong input. */
  "invite.device": "This device couldn't finish making the invitation, and nothing was shared. Reload the page to try again, or use another phone or computer.",

  /** The share step's heading. The label is the owner's own text. */
  "invite.share.title": (label: string) => `Invitation for ${label}`,
  "invite.qr.a11y": (label: string) => `QR code of the invitation link for ${label}`,
  /** ⟦copy: invite.housekey⟧ — invite spec §3, brief §11: whoever holds it can open the album. Beside every QR. */
  "invite.housekey": "This QR code and its link are like a house key. Anyone who has either one, even a photo of the code, can open this album until you revoke it.",
  /** The same rule beside a passphrase invite's link: the link alone is not the key, the link and the words together are. */
  "invite.housekey.passphrase": "This link and the passphrase together are like a house key. Anyone who has both can open this album until you revoke it.",
  /** ⟦copy: invite.once⟧ — this link cannot be shown again (flows §3.8). */
  "invite.once": "This invitation can't be shown again. If you leave before sending it, you'll need to make a new one.",
  "invite.link.label": "The link",
  "invite.link.copy": "Copy the link",
  "invite.link.copied": "Link copied.",
  "invite.link.copy-failed": "The link couldn't be copied. Select it above and copy it yourself.",
  /** navigator.share, on devices that have a share sheet. */
  "invite.link.share": "Send the link…",
  /** ⟦copy: invite.channels⟧ — send the link and the passphrase separately (encryption spec §6.5). */
  "invite.channels": "Send the link and the passphrase separately: the link by message, for example, and the words by phone or on paper.",
  "invite.passphrase.label": "The passphrase",
  /** The language the words are in, by its name in the interface's language. */
  "invite.passphrase.language": (language: string) => `Words in ${language}`,
  "invite.done": "Done",
  "invite.leave.title": "Leave this invitation?",
  /** Flows §3.8: the remedy is a new invite, and revoking this one if it may already have been sent. */
  "invite.leave.consequence": "Once you leave, this invitation can't be shown again. If you haven't sent it, you'll need a new one. If it may have reached the wrong person, revoke it from Invited people.",
  "invite.leave.stay": "Stay here",
  "invite.leave.confirm": "Leave",

  // ── Invited people and revoke (flows §3.9) ────────────────────────────────
  // Revoke-wide rule (brief §8, "Revocation is server-enforced, not
  // cryptographic"): revoking stops future access, at once, and the copy may
  // say so; it never implies that anything already seen is withdrawn.

  "people.title": "Invited people",
  "people.back": "Back to the album",
  "people.loading": "Loading…",
  "people.empty": "No one has been invited to this album yet.",
  /** A label that will not open: the person is listed anyway (as albums are, flows §3.4). */
  "people.unreadable": "A name that can't be read on this device",
  "people.revoked": (when: string) => `Revoked ${when}`,
  "people.revoke": "Revoke",
  /** A 404 on revoke: the list was stale, and has been fetched again (flows §3.9). */
  "people.refreshed": "This list was out of date, so it has been loaded again. Check it before revoking anyone.",
  "people.log": "Access log",
  "people.log.person": (label: string) => `What ${label} opened`,
  "people.log.person.unnamed": "What they opened",

  /** ⟦copy: revoke.confirm⟧ — immediate, future access only (brief §8). */
  "revoke.confirm.title": (label: string) => `Revoke the invitation for ${label}?`,
  "revoke.confirm.title.unnamed": "Revoke this invitation?",
  "revoke.confirm": "It stops working at once: from their next request on, it opens nothing. It can't take back anything they've already seen.",
  "revoke.yes": "Revoke",
  "revoke.no": "Keep it",
  "revoke.busy": "Revoking…",
  /** ⟦copy: revoke.done⟧ — immediate, future access only; re-inviting means a new invitation (flows §3.9). */
  "revoke.done": "Revoked. That invitation opens nothing from now on. Anything already seen can't be taken back. To let them back in, make a new invitation.",
  "revoke.failed": "This invitation couldn't be revoked. Try again.",

  // ── Access log (flows §3.10, api-sketch §11.6) ────────────────────────────
  // Log-wide rules: "opened" and only the permitted column of §11.6's table:
  // never viewed, seen, visited or looked at. A sparse log is not evidence of
  // restricted access, and nothing here may suggest it is. Never say a photo
  // was not opened: thumbnails never log.

  /** ⟦copy: log.summary⟧ */
  "log.summary.opens": (n: number) => (n === 0 ? "Hasn't opened this album yet" : n === 1 ? "Opened this album once" : `Opened this album ${n} times`),
  /** Shown only when at least one photo was opened: a zero would read as "has not seen any", which thumbnails make untrue. */
  "log.summary.photos": (n: number) => (n === 1 ? "Has opened 1 photo" : `Has opened ${n} photos`),
  "log.summary.last": (when: string) => `Last opened ${when}`,
  /** §11.6: behavioural, not authorisational. Beside every list of counts. */
  "log.sparse": "This shows what each person opened, not what they can open: everyone here who isn't revoked can open every photo in this album.",
  /** §11.6: the metric is opens, not intentional viewings. */
  "log.counts": "Each time the album or a photo is opened counts once, including reloads.",

  "log.title": "Access log",
  "log.title.person": (label: string) => `What ${label} opened`,
  "log.title.person.unnamed": "What they opened",
  "log.back": "Back to invited people",
  "log.loading": "Loading the log…",
  /** ⟦copy: log.none⟧ */
  "log.none": "No one has opened this album yet.",
  "log.none.person": "They haven't opened this album yet.",
  /** ⟦copy: log.entry⟧ */
  "log.entry.album": (label: string) => `${label} opened this album`,
  "log.entry.photo": (label: string) => `${label} opened this photo`,
  "log.entry.album.unnamed": "Someone whose name can't be read opened this album",
  "log.entry.photo.unnamed": "Someone whose name can't be read opened this photo",
  /** Flows §3.10: hidden and not yet erased. Must not promise when or whether erasure completes. */
  "log.photo.removed": "A photo you removed. It's hidden from everyone now, and its entries go when its stored copy is erased.",
  "log.photo.failed": "This photo couldn't be shown.",
  "log.photo.loading.a11y": "Photo loading",
  "log.photo.a11y": "The photo that was opened",
  "log.more": "Show older entries",
  "log.more.busy": "Loading older entries…",

  // ── Licences ──────────────────────────────────────────────────────────────
  // What the app ships that others made. Names the work and its licence;
  // claims nothing about the app.

  /** From the album list: the one way in. */
  "licences.link": "Licences",
  "licences.title": "Licences",
  "licences.intro": "Vitrina includes work by other people, used under these licences. Each link opens the licence text.",
  "licences.font": "The Atkinson Hyperlegible font — SIL Open Font License 1.1",
  "licences.wordlist.en": "The English passphrase words (EFF Large Wordlist) — CC BY 4.0",
  "licences.wordlist.es": "The Spanish passphrase words, a selection built from OpenSubtitles word frequencies, Wiktionary and the Universal Dependencies Spanish treebanks — CC BY-SA 4.0",
  "licences.blocklist": "The very common passwords refused at sign-up (SecLists) — MIT License",
  "licences.back": "Back to Vitrina",
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

/** For the access log and people.revoked: "14:05" today, "Thu 15 Oct, 14:05" this year, "15 Oct 2025, 14:05" before. */
export function logTime(d: Date, now: Date): string {
  if (d.toDateString() === now.toDateString()) return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(d);
  const opts: Intl.DateTimeFormatOptions =
    d.getFullYear() === now.getFullYear()
      ? { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat("en-GB", opts).format(d);
}

/** For log.summary.last: "6 Aug", as api-sketch §11.6's example, with the year when it isn't this one. */
export function logDay(d: Date, now: Date): string {
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear() ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" };
  return new Intl.DateTimeFormat("en-GB", opts).format(d);
}

/** A passphrase language's name, in the interface's language: "English", "Spanish". Falls back to the code. */
export function languageName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The countdown for credential.paused: "about 12 minutes", "45 seconds". Rounded up, never "0". */
export function pauseLeft(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return seconds === 1 ? "1 second" : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? "about 1 minute" : `about ${minutes} minutes`;
}
