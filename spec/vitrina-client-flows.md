# Vitrina — Client Flows

**Status:** Draft for owner review · 9 October 2026
**Governs:** which screens `packages/web` has, which states each can be in, and what each step calls. Not layout, not visual design, not framework structure — prototypes and the per-flow implementation chats own those.

---

## 0. How to read this document

- **Each flow is a sequence of transitions between the key states in §1.** A step names the route it calls exactly as that route's row appears in api-sketch §11.8. Bodies live there and are not restated.
- **One route has no api-sketch §11.8 row yet:** `DELETE /v1/media/{media_id}`, built in parallel (§3.7). Its row is owed.
- **Copy slots** are marked ⟦copy: _name_ — _rule_⟧. The text is written where the screen is built. The rule named is what it must satisfy. Every slot is also bound by brief §3's never-claim list and, in every language but English, by brief §15.3. The one text quoted here is brief §16, in §4.3.
- **Two failures apply to every call and are listed once, here.** Network loss: an offline state that retries and **never changes key state** — no storage cleared, no handle freed. Only an owner `401` or a recipient `403`/`401` does that. And `429 RATE_LIMITED`: wait for the interval in `Retry-After`, then retry (api-sketch §11.5).
- **Not drawn:** "my albums / shared with me", password change and recovery, a persistent "this is my device", album deletion, video, native apps, universal links, device-bound invites, and "remember on this device" for recipients.

## 1. Key state is UI state

### 1.1 Owner

| State      | `sessionStorage` | In memory                                                  | Screen                         |
| ---------- | ---------------- | ---------------------------------------------------------- | ------------------------------ |
| `O-none`   | nothing          | nothing                                                    | sign in · sign up              |
| `O-locked` | token, `expires_at` | `wrapped_master` + parameters, from `GET /v1/owner/key` | unlock                         |
| `O-open`   | token, `expires_at` | `K_master`, plus every `K_album` from `GET /v1/albums`  | album list and everything after |

- **Only the token and its `expires_at` are stored** (brief §12, "Session refresh"). The expiry is neither secret nor personal. It is stored because the unlock path never receives it, and without it no warning is possible after a reload (§3.12). No key, KEK, password or email goes to storage.
- **The KEK and password exist only during a derivation wait (§2) and the step after it.** The proof is zeroed after `POST /v1/signup` or `POST /v1/login`. `K_master` is not stored in any state.
- **A `401` from any owner route, in any state:** clear storage, free every handle (api-sketch §8.4), go to `O-none`. Any work in progress is lost (§3.6).
- **Nothing moves `O-open` to `O-locked` except a page load.** There is no "lock" action in v1.
- `sessionStorage` is per tab. A new tab usually starts in `O-none` and its sign-in mints another session. A duplicated tab may start in `O-locked`. The page-load branch in §3.1 handles both.

### 1.2 Recipient

| Mode       | State      | In memory                                                | Screen                 |
| ---------- | ---------- | -------------------------------------------------------- | ---------------------- |
| QR         | `Q-held`   | token, `K_album` — both from the fragment                | onboarding, grid, viewer |
| QR         | `Q-lost`   | nothing                                                  | dead page (§4.7)       |
| Passphrase | `P-locked` | token from the fragment; the wrapping from `GET /v1/recipient/key` | passphrase entry       |
| Passphrase | `P-open`   | token, `K_album`                                         | onboarding, grid, viewer |

**Terminal screens, not key states:** _revoked_ (`403 ACCESS_REVOKED`) and _not recognised_ (`401`), both in §4.6. Either can be reached from any state that holds a token, and both free `K_album`. A passphrase recipient who has lost the token also lands on the dead page. Where recipient state survives a reload is open (§4.7).

## 2. The derivation wait

**This is one screen state, and several screens use it:** unlock (§3.1), signup (§3.2), sign-in (§3.3), passphrase invite creation (§3.8) and passphrase entry (§4.2). Each runs Argon2id once. The owner's parameters are fixed (brief §12). A recipient's come from their own row (api-sketch §10.1). The worst measured time is 2239 ms on the slowest target phone (phase-0-plan §8). Because unlock runs on every page load, this is the screen owners will see most. Design it as a screen, not as a spinner added afterwards.

- **Entered before derivation starts, left only on a result.** While it runs, the input that started it cannot be edited and cannot be submitted again.
- **No progress figure** unless the derivation actually reports one.
- **It has exactly three exits:** success, which goes to the next state; _wrong secret_, which is the hosting screen's failure state; and _could not derive_. The last one covers an allocation or WASM failure (brief §11, mobile Safari memory), and it must never be shown as a wrong password.
- **A tab discarded during the wait** comes back through page load: §3.1 for owners, §4.7 for recipients.

⟦copy: derive.wait — says this device is unlocking. It must not describe the wait as encryption or protection, and makes no claim beyond brief §3's promises⟧
⟦copy: derive.failed — this device could not finish. It must be different from a wrong password (brief §11)⟧

## 3. Owner flows

### 3.1 Page load and unlock

| From       | Step                                                 | Call                                   | To                                            |
| ---------- | ---------------------------------------------------- | -------------------------------------- | --------------------------------------------- |
| —          | read the token                                       | —                                      | none → `O-none`, sign-in screen (§3.3)        |
| token held | fetch the wrapping **before** asking for the password | `GET /v1/owner/key`                    | `200` → `O-locked` · `401` → clear, free, `O-none` |
| `O-locked` | password → derivation wait → unwrap locally          | —                                      | tag fails → stays `O-locked` · success → `K_master` |
|            | unwrap every album key                               | `GET /v1/albums`                       | `O-open`, album list                          |

- **The `401` branch is settled before any password is asked for.** If the session has already ended, nobody types a password into its unlock screen.
- **A wrong password is the AEAD tag failing locally.** No request is made, nothing is logged, and no limiter counts it. Each attempt costs only the wait. Unlock never calls `POST /v1/login`, so it never mints a session (brief §12).
- **No password policy check here.** The policy applies at signup only (brief §12).
- **Sign-out is offered from the unlock screen** (§3.11), for a shared device or the wrong account.

**Decided: the unlock screen says only "Unlock". No email is stored.** Brief §12 limits storage to the token and its expiry. Keeping the address as well would widen that just to supply a label. It would also put personal data in storage that any script on the origin can read, and buy no capability in return: `GET /v1/owner/key` is scoped by the token, so the address plays no part in unlocking. The cost: on a shared device, the screen does not say whose account it is. The sign-out action covers that case.

**Waiting:** before `GET /v1/owner/key` answers · the derivation wait · `GET /v1/albums` and the unwraps.
**Failing:** `401` at either call · wrong password · could not derive · an album wrapping or title that will not open, which is shown on that album (§3.4) and not dropped.

⟦copy: unlock.prompt — "Unlock" and no address, as decided above⟧
⟦copy: unlock.wrong — must not suggest that attempts are counted or that the account will lock, because nothing counts them⟧

### 3.2 Signup

`O-none` → `O-open`. Argon2id runs once on this device (api-sketch §8.4, signup paragraph).

| Step | What                                                                        | Call                | Secrets afterwards                                          |
| ---- | --------------------------------------------------------------------------- | ------------------- | ----------------------------------------------------------- |
| 1    | address and password; policy checked locally                                | —                   | password (a JS string, which cannot be wiped — api-sketch §8.4) |
| 2    | generate `K_master` and salt → derivation wait → KEK and proof → wrap `K_master` | —                   | `K_master`, KEK, proof                                      |
| 3    | create the account                                                          | `POST /v1/signup`   | token, `expires_at` → `sessionStorage`; proof zeroed; KEK freed |
| 4    | —                                                                           | —                   | `O-open`, empty album list. No `GET /v1/owner/key`          |

- **The password policy is enforced here and nowhere else** (brief §12, "Owner password policy").
- **The consequence of forgetting the password is shown before submission**, not discovered later (brief §11).

**Failing:** `409 CONFLICT` means the address is already registered, so offer sign-in instead · `400` means a client build error (api-sketch §7.5), shown as a generic failure · **the response is lost after sending**, so the account may exist: offer sign-in with the same password, which succeeds if it was created. A blind retry would answer `409`.

⟦copy: signup.policy — brief §12's policy: a length floor and a blocklist, with no composition rules⟧
⟦copy: signup.loss — forgetting the password loses every album, and no reset recovers them (brief §11, "Accepted cost")⟧
⟦copy: signup.taken — must not claim that account existence is private (brief §11, "Account existence is discoverable through signup")⟧
⟦copy: signup.uncertain — the account may have been created. Sign in to find out⟧

### 3.3 Sign-in on a new device

`O-none` → `O-open`. These are api-sketch §8.4 steps 1–4, then the album keys.

| Step | Call                     | Client holds afterwards                                  |
| ---- | ------------------------ | -------------------------------------------------------- |
| 1    | `POST /v1/login/params`  | salt, parameters                                         |
| 2    | derivation wait (§2)     | KEK, proof                                               |
| 3    | `POST /v1/login`         | token, `expires_at` → `sessionStorage`; proof zeroed     |
| 4    | `GET /v1/owner/key`      | `K_master`; KEK freed                                    |
| 5    | `GET /v1/albums`         | every `K_album` → `O-open`                               |

**Failing:** `401 INVALID_CREDENTIALS` at step 3. It arrives after the full wait, and it is identical for a wrong password and an unknown address (api-sketch §4.3) · **step 4 fails to unwrap after a successful login**. A correct password cannot cause that, so it is not "wrong password": revoke the new token (`POST /v1/logout`) and show a hard failure.

⟦copy: signin.failed — must not say which half was wrong (api-sketch §4.3)⟧
⟦copy: signin.cannot-unlock — signed in, but this account's key would not open. Not a password error⟧

### 3.4 Album list and the owner's album

**Album list** (`O-open`). Data comes from the `GET /v1/albums` call already made on entry. Titles are decrypted under `K_title`. `media_count` counts items in any status, so it is shown as a number of items, not as photos (api-sketch §9.2).

**Album.** `GET /v1/albums/{album_id}` lists every item and its status. `GET /v1/albums/{album_id}/metadata` returns `ready` items only. Thumbnails come from `GET /v1/media/{media_id}/thumbnail`, and the full image from `GET /v1/media/{media_id}/asset`. Owner calls write nothing to the access log (api-sketch §11.6). An item is drawn in one of these states: `pending`, `processing`, `ready`, `failed`, or _stalled_. Stalled means `pending` or `processing` with an old `updated_at`, read from `GET /v1/media/{media_id}` (api-sketch §9.8). From here the owner can upload, remove, create an invite, see recipients, and open the access log.

**Failing:** a title or wrapping that will not open is shown on its album, not hidden · a thumbnail that fails gets a failed state on its own cell.

⟦copy: albums.empty — no rule beyond brief §3⟧
⟦copy: albums.count — items, not photos (api-sketch §9.2)⟧
⟦copy: album.stalled — states how long the item has been stuck and offers removal. No guess at the cause (api-sketch §9.8)⟧

### 3.5 Create album

`O-open`. Locally: generate the album id and a random `K_album`, wrap `K_album` under `K_master`, and encrypt the title, which has a 200-character client limit (api-sketch §5.3). Then `POST /v1/albums`. A `409` means a lost response, so treat it as created (api-sketch §9.2). The new `K_album` handle joins the session's set.

⟦copy: album.title — may say the relay cannot read the title (api-sketch §5.3). Nothing stronger⟧

### 3.6 Upload

**Each item moves through this ladder.** Everything up to step 3 happens on the device.

1. **Prepare:** decode the image, strip EXIF and GPS (non-negotiable #11), downscale to a 1600 px long edge (non-negotiable #14), and generate the thumbnail (non-negotiable #13). The filename and capture time go only into the metadata envelope (non-negotiable #12; encryption spec §7).
2. **Encrypt:** generate the media id, then encrypt the asset, thumbnail and metadata envelopes under keys derived from `K_album`.
3. `POST /v1/albums/{album_id}/media` creates the row as `pending`. A `409` means it was already created: go on to step 4 **with the same id**, never a new one (api-sketch §9.6).
4. `PUT /v1/media/{media_id}/asset` and `PUT /v1/media/{media_id}/thumbnail`, in either order.
5. **Wait for the server's `ready`.** On `processing`, poll `GET /v1/media/{media_id}`. **No item is ever shown as done on the client's own evidence** (api-sketch §9.7).

**States drawn per item:** preparing · encrypting · uploading · waiting for the server · ready · failed (re-upload under the same id, api-sketch §9.7) · stalled.

- **If stripping fails, the item fails.** It is never uploaded unstripped (non-negotiable #17).
- **The prepared bytes exist only in memory.** A closed tab or a `401` abandons every item in flight. Those items then appear in the album as `pending` or `failed`, with nothing left to re-send, and the remedy is removal (§3.7).

⟦copy: upload.stripped — may say that location and camera details are removed before anything leaves the device (brief §3, "We promise")⟧
⟦copy: upload.downscale — may say a viewing-size copy is sent. Must not claim this prevents copying (brief §3)⟧
⟦copy: upload.failed · upload.stalled — retry or remove. No reason string, because the server sends none (api-sketch §9.8)⟧

### 3.7 Remove a photo

**Route:** `DELETE /v1/media/{media_id}`, allowed from any status. The relay hides the item at once and then erases it. The response says whether erasure is **complete** or **still pending**.

| State                     | Call / data                                                                      | Next                                   |
| ------------------------- | -------------------------------------------------------------------------------- | -------------------------------------- |
| confirm                   | the item's `created_at` from `GET /v1/albums/{album_id}`; each recipient's `last_opened_at` from `GET /v1/albums/{album_id}/access-log` | removing                               |
| removing                  | `DELETE /v1/media/{media_id}`                                                    | one of the two states below            |
| removed, erasure complete | —                                                                                | item gone from the album               |
| removed, erasure pending  | `DELETE /v1/media/{media_id}` again, with backoff, while the screen stays open   | item gone from the album; complete once a retry reports it |

**The confirm screen computes its statement. It never assumes one:**

- **The item was never `ready`:** no recipient could have retrieved it (api-sketch §9.5, §11.2).
- **No recipient's `last_opened_at` is later than the item's `created_at`:** _"No one has opened this album since you added it."_ `created_at` is earlier than `ready`, so this comparison errs towards saying the album _has_ been opened.
- **Otherwise:** removal stops future access and does not undo anything already retrieved.

**Never say a photo was not opened.** Thumbnails never log (api-sketch §11.6), so a missing `asset_viewed` does not mean nobody had the photo on screen.

**Erasure pending can outlive the screen.** A hidden row drops out of `GET /v1/albums/{album_id}`, so once the owner leaves, nothing in the client can see it or retry it. **Its access-log entries are removed with it.** The deletion cascades, so they disappear when erasure completes.

**Failing:** `404` means it was already removed from another tab or device, so treat it as removed · `401`. A recipient who is viewing the photo gets `404` on their next request (§4.5).

⟦copy: remove.never-ready — nobody could have retrieved it⟧
⟦copy: remove.unopened — conveys "No one has opened this album since you added it." Uses "opened" only (api-sketch §11.6)⟧
⟦copy: remove.opened — stops future access only. Must not imply that what was retrieved is withdrawn (brief §8)⟧
⟦copy: remove.pending — hidden from everyone now; its stored copy has not been erased yet. Must not promise when or whether erasure completes, say "under way", or imply anything runs after this screen closes⟧

### 3.8 Create invite

`O-open`, inside an album.

1. **Mode.** QR is the default. Passphrase is the fallback, but must not be presented as weaker in every respect (invite spec §4; encryption spec §6.5).
2. **Label.** This is the name the watermark will carry (brief §5). It is encrypted under `K_label`.
3. **Generate** the recipient id, the token and `token_hash`.
4. **QR:** the payload carries `K_album`. **Passphrase:** pick the wordlist, defaulting to the owner's display language and changeable, offering only vetted languages (brief §15.2; encryption spec §6.3). Then generate at least 5 words, run the derivation wait, and wrap `K_album`.
5. `POST /v1/albums/{album_id}/recipients`. **Nothing is shown for sharing until it answers `201`.** A `409` means regenerate the id and token and retry (api-sketch §7.7). In passphrase mode the wrap is redone under the new id.
6. **Share screen.** QR: the link and its QR, rendered to invite spec §3's requirements. Passphrase: the link and the passphrase shown separately, with an instruction to send them by different channels (encryption spec §6.5).

- **The key material goes in the fragment: `#`, never `?`** (invite spec §2.1).
- **The share screen is shown once.** The relay holds only `token_hash` and the client stores nothing, so leaving this screen loses the link for good. The remedy is a new invite, and revoking this one if it may already have been sent. Leaving must ask for confirmation.

⟦copy: invite.mode — neither mode is stronger in every respect (encryption spec §6.5)⟧
⟦copy: invite.housekey — the link or QR is like a house key, and whoever holds it can open the album (invite spec §3; brief §11)⟧
⟦copy: invite.once — this link cannot be shown again⟧
⟦copy: invite.language — the passphrase language is the recipient's, not the app's (brief §15.2)⟧
⟦copy: invite.channels — send the link and the passphrase separately (encryption spec §6.5)⟧

### 3.9 Recipients and revoke

**Data:** `GET /v1/albums/{album_id}/access-log`, the per-recipient summary. It is the only route that lists an album's recipients (api-sketch §11.7). Labels are decrypted under `K_label`. Revoked recipients are listed and marked as revoked.

**Revoke:** confirm → `POST /v1/recipients/{recipient_id}/revoke` → revoked. The route is idempotent, so a retry counts as success. **Failing:** `404` means the screen is stale, so refresh it.

- **Revocation is immediate, and the UI may say so** (api-sketch §7.8).
- **It stops future access only.** It undoes nothing already retrieved, and a QR recipient keeps the key they hold (brief §8; encryption spec §6.4). Re-inviting the same person means a new invite (§3.8).

⟦copy: revoke.confirm · revoke.done — immediate, future access only (brief §8, "Revocation is server-enforced, not cryptographic")⟧

### 3.10 Access log

**Data:** the summary from §3.9, plus `GET /v1/albums/{album_id}/access-log/entries`, paged by `next_before` and filterable by recipient or by media. A photo named in an entry is identified through the owner's own metadata and thumbnail. **An entry whose media is no longer in the album** needs a drawn state. That state exists only while the photo is hidden and not yet erased. Erasure cascades, so its entries go with it (§3.7).

- **Use only the permitted column of api-sketch §11.6's vocabulary table.**
- **A sparse log is not evidence of restricted access** (api-sketch §11.6). Zero opens describes what someone did, not what they could do.

⟦copy: log.summary · log.entry · log.none — api-sketch §11.6, permitted column only⟧

### 3.11 Logout

**Two actions:** this device (`POST /v1/logout`) and every device, this one included (`POST /v1/logout/all`).

**Order:** free every handle first, then call the route, then clear storage → `O-none`. Revoking and freeing can fail independently (api-sketch §8.4). **If the call fails:** the keys are already freed, and the token is kept only so the call can be retried. Show _signed out on this device; the session could not be ended on the server_. The user can retry, or leave, which clears storage anyway.

⟦copy: logout.everywhere — ends every session, including this one⟧
⟦copy: logout.partial — the keys are gone from this device, and the server session may still be live until it expires⟧

### 3.12 Session expiry

`O-open`, as the stored `expires_at` approaches. There is no refresh route (api-sketch §7.5). When the session lapses, the next call answers `401`, and the `401` rule in §1.1 then abandons every upload still in flight (§3.6).

- **Ending soon:** a warning is shown in `O-open` before the session ends. Starting an upload in that window must warn that it may not finish.
- **Ended:** `401` → clear, free, `O-none`. The sign-in screen says the session ended. It must not suggest that something went wrong.
- **The clock is the device's.** `expires_at` is server time, and a device whose clock is wrong will warn early or late. The `401` remains the authority, and the warning is only a courtesy.

⟦copy: session.ending — when the session ends, and that uploads still running at that point will be lost⟧
⟦copy: session.ended — signed out because the session ended. Sign in again⟧

## 4. Recipient flows

### 4.1 Open link

1. **Parse the fragment.** If it is missing or malformed → dead page (§4.7).
2. **Validate `relay`** against the allowlist (invite spec §1). An unfamiliar relay gets a confirmation screen **before any request**.
3. **Call `history.replaceState`** to strip the fragment (invite spec §2.2). Its interaction with storage is pending (§4.7).
4. **Branch:** `key` present → `Q-held`; `key` absent → `P-locked` (§4.2).
5. **`Q-held`:** call `GET /v1/recipient` and decrypt the label for the watermark. `403` → revoked; `401` → not recognised (§4.6).
6. Onboarding (§4.3), then the grid (§4.4).

**Call `GET /v1/albums/{album_id}/metadata` on entering the grid, not behind onboarding.** That call _is_ the album open (api-sketch §11.6), and making it here means each open in the owner's log matches a grid that was actually on screen. `GET /v1/recipient` and `GET /v1/albums/{album_id}` write no log and may run during onboarding.

⟦copy: open.unfamiliar-relay — names the origin and asks before contacting it (invite spec §1, phishing)⟧

### 4.2 Enter passphrase

`P-locked`. Fetch `GET /v1/recipient/key` on arrival. `403` → revoked before anything is typed · `401` or `404` → not recognised (api-sketch §10.1). Then:

1. **Normalise** the entry (encryption spec §6.3). If it is empty after normalising, reject it without deriving.
2. **Run the derivation wait** with the row's own parameters, then unwrap locally.
3. **Tag fails** → wrong passphrase, stay in `P-locked`. The relay never learns of the failure (api-sketch §10.3). **Success** → `P-open` → `GET /v1/recipient` → onboarding.

⟦copy: pass.entry — may say that capitals and accents do not matter, which is true under encryption spec §6.3's normalisation⟧
⟦copy: pass.empty⟧
⟦copy: pass.wrong — no attempt counter, because nothing counts⟧
⟦copy: pass.lost — nobody can recover a lost passphrase. The person who invited you can send a new invitation (brief §11, "Key loss")⟧

### 4.3 Onboarding

**Shown after the key is held and before the grid.** Nothing records that it was read, so it appears every time someone enters through the link. The text is brief §16, verbatim:

> Someone has opened a window to share something with you: you have been given access to an album of their choice, and you can visit it as many times as you want.
>
> Nothing is automatically saved to your phone or laptop. There is no file to forward. Pictures are unreadable on our servers.
>
> The link is the key: keep it to yourself. Screenshots leave marks, and all invitations are revocable.

**Its third paragraph is the house-key presentation** that brief §11 and invite spec §3 require. Nothing else on the screen may soften it.

⟦copy: onboarding.continue — no rule beyond brief §3⟧

### 4.4 Grid

**Calls:**

- `GET /v1/albums/{album_id}`: title and statuses.
- `GET /v1/albums/{album_id}/metadata`: dimensions. This call logs `album_opened`.
- `GET /v1/media/{media_id}/thumbnail` for each `ready` item. Thumbnails may be prefetched freely, and they are downloaded again on every open (brief §10.1).

**Obligations:**

- **Hide anything that is not `ready`** (api-sketch §9.4). An album with nothing `ready` has an empty state.
- **Render to canvas.** Suppress `contextmenu`, `dragstart` and `selectstart`, and revoke blob URLs after drawing (brief §10).
- **Watermark every rendered image**, client-side, from the decrypted label and the date (brief §5).
- **The grid never fetches a full asset** (api-sketch §11.6).

**Waiting:** the metadata, because no layout is possible without dimensions (encryption spec §7) · thumbnails, which fill in progressively.
**Failing:** a thumbnail that fails to fetch or decrypt gets a failed state on its own cell · `403` → revoked · the title fails to decrypt under a QR link's key, which means a damaged link: show the dead page.

⟦copy: grid.empty⟧
⟦copy: watermark — name and date. It works socially, not forensically, and must not claim to identify or trace anyone (brief §5)⟧

### 4.5 Viewer

- **Fetch only when the photo is displayed.** First a range from byte 0 (header and chunk 0), which logs `asset_viewed`. Later ranges are computed arithmetically (encryption spec §3.3). **Neighbouring photos are not prefetched.** The thumbnail already in memory may stand in while the fetch runs.
- **Render to canvas, with the watermark and explicit zoom and pan controls** (brief §11: a requirement).

**Failing:** `404` means the owner removed the photo after the grid loaded (§3.7) · `403` → revoked · decryption fails · the device runs out of memory (brief §11), which is its own state.

⟦copy: viewer.controls — zoom and pan labels (brief §11, accessibility)⟧
⟦copy: viewer.removed — no longer in this album⟧
⟦copy: viewer.failed — could not be shown on this device⟧

### 4.6 Revoked, and not recognised

**Revoked** means any `403 ACCESS_REVOKED`. Free `K_album`, and drop every decrypted image, the title, the label and any invite held for the tab (§4.7). The screen shows nothing from the album.

**Not recognised** means a recipient `401`: an unknown token, for example a link that was typed wrongly.

⟦copy: revoked — this album is no longer shared with you. Must give no reason, and must not imply that anything already retrieved is gone (brief §8; encryption spec §6.4). The remedy is the person who invited you⟧
⟦copy: notrecognised — this invitation does not work. Ask the person who sent it⟧

### 4.7 Recipient reload — ⟪PENDING⟫

**Drawn: the state. Open: the mechanism.** A real-phone test is under way (`scripts/tab-reload-test/`).

| After a reload or a discarded tab | Preferred mechanism                          | Fallback                  |
| --------------------------------- | -------------------------------------------- | ------------------------- |
| QR                                | `Q-held`, restored from tab-scoped storage   | `Q-held`, from the fragment |
| Passphrase                        | `P-locked`: the token is restored, the passphrase is asked again | `P-locked`                |
| Tab closed                        | dead page                                    | dead page                 |

- **Preferred:** on first load, copy the fragment's contents into `sessionStorage` (tab-scoped), then call `replaceState`. A reload or a discarded tab reads them back. As written today, invite spec §2.2 step 4 forbids writing `key` to `sessionStorage`.
- **Fallback, if storage does not survive a discard:** never strip the fragment. The cost is exposure through the share sheet, bookmarks and tab sync.
- **Under both mechanisms, a passphrase recipient never comes back already `P-open`**, because `K_album` was never in the fragment.

**The dead page** is reached when the tab was closed, the fragment is missing or malformed, or a bookmark holds no invite. It knows nothing: titles and labels are ciphertext, and there is no key. All it can offer is to open the invitation link again.

⟦copy: dead — open your invitation link again. Nothing else is known⟧

Invite spec §2.2's "remember on this device" is still open and is not touched here.

### 4.8 Return visit

**The same flow as §4.1, from the start.** Each return writes a new `album_opened` row (api-sketch §11.6). A passphrase recipient enters the passphrase again every time. A bookmark saved after the fragment was stripped leads to the dead page (§4.7).
