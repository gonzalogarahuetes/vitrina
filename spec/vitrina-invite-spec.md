# Vitrina — Invite Payload Specification

**Version:** 1
**Status:** Draft for review · 6 August 2026
**Companion to:** `vitrina-encryption-spec.md`, `vitrina-project-brief.md` §6.7

---

## 0. Why this is a spec and not an implementation detail

The obvious approach is "a URL with the key in the fragment." That works, and it quietly makes the web transport the abstraction — so when the iOS app arrives in Phase 4 and needs a universal link, and the QR needs to be as short as possible, and a recipient needs a passphrase read over the phone, you end up with three ad-hoc string formats that agree by accident.

Defining the payload as an object with three serialisations costs nothing now and makes Phase 4 a rendering problem instead of a redesign.

---

## 1. The payload object

```jsonc
{
  "v":     1,                  // integer, payload version
  "relay": "https://…",        // origin of the relay serving this album
  "album": "…",                // 16 bytes, base64url, no padding
  "token": "…",                // 32 bytes, base64url, no padding — access token
  "key":   "…"                 // 32 bytes, base64url, no padding — K_album
}
```

`key` is present in **direct mode** and absent in **passphrase mode** (§4).

All binary fields use base64url without padding (RFC 4648 §5). Sizes: `album` → 22 chars, `token` → 43 chars, `key` → 43 chars.

`relay` is included rather than hardcoded so that a self-hosted deployment (roadmap Phase 5) produces working invites without a client rebuild. Clients MUST validate it against an allowlist or require explicit user confirmation before contacting an unfamiliar origin — an invite is untrusted input, and a payload that points at an attacker's relay is a phishing vector.

### 1.1 `token` and `key` are independent secrets

Restating the point from the encryption spec §6.4, because the fact that they travel together is exactly what makes it easy to conflate them:

- `token` authorises **fetching ciphertext** from the relay. The relay stores its hash and can revoke it.
- `key` authorises **decrypting** that ciphertext. The relay never receives it and can never revoke it.

Two secrets, two parties, one envelope.

---

## 2. Serialisation: URL

```
https://{relay}/v/#v=1&a={album}&t={token}&k={key}
```

### 2.1 The fragment is load-bearing

`token` and `key` MUST appear in the **URL fragment**, never in the query string or path.

Fragments are not transmitted in HTTP requests. A query string would send `K_album` to the relay in the very first request, in plaintext, and into its access logs — destroying the single most valuable property of the entire system in one character (`?` instead of `#`).

This is the highest-consequence, lowest-visibility mistake available in this codebase. It will look fine, work perfectly, and be catastrophic. It deserves an explicit test asserting that no outbound request URL ever contains key material.

### 2.2 Client obligations on load

1. Parse the fragment
2. Derive keys and hold them **in memory only**
3. Immediately call `history.replaceState` to strip the fragment from the visible URL
4. Never write `key` to `localStorage`, `sessionStorage`, IndexedDB, or a cookie

Step 3 is cosmetic against a determined party — the fragment is already in browser history and possibly in the clipboard — but it stops the key being shoulder-surfed from an address bar, screenshotted along with the page, or copied when a grandparent shares "the link that worked."

**Consequence to design around:** because the key is memory-only, a page refresh loses access and requires re-scanning or re-opening the invite. That is a real usability cost for the least technical users we have. Whether to offer an explicit, opt-in "remember on this device" that persists the key to IndexedDB is an **open decision** — it trades the strongest property we have for the convenience of the audience who needs convenience most. Do not resolve it by accident.

---

## 3. Serialisation: QR code

The QR encodes the §2 URL verbatim.

**Size check.** A typical payload: relay origin ~30 chars, path and separators ~14, `album` 22, `token` 43, `key` 43 → roughly 152 characters of alphanumeric-plus-symbol data. That fits comfortably in a QR version 7–8 at error correction level M, which scans reliably from a phone camera at conversational distance, including from a printed card or a screen.

**Requirements:**

- Error correction level M or higher
- Quiet zone of at least 4 modules
- Rendered at a size that survives being photographed off a screen — this is how it will actually be delivered most of the time
- The recipient-facing UI MUST accompany it with plain language: *this QR is like a house key — anyone who photographs it can see the album.* The audience will not infer this.

A QR printed on paper is a physical bearer secret with no expiry beyond token revocation. That is an acceptable and even desirable property — it is how a grandparent can be given access at a family lunch without any account, email address, or app install — but the UI must not present it as merely a convenience.

---

## 4. Passphrase mode

For delivery by voice or handwriting, where a QR cannot reach.

The payload omits `key`:

```
https://{relay}/v/#v=1&a={album}&t={token}
```

The recipient receives the link (or scans a QR of it) **and, separately, a 5-word passphrase**. The client fetches the wrapped key, salt, and Argon2id parameters from the relay, derives the KEK, and unwraps `K_album` per encryption spec §6.2.

Passphrases are system-generated, minimum 5 words, from a Spanish or Catalan wordlist. See encryption spec §6.3 — user-chosen passphrases are forbidden, and the reason is not paternalism.

**Security note:** this mode is strictly weaker than direct mode, because the relay now stores a wrapped copy of `K_album` and can attack it offline given a weak passphrase. It exists because delivery constraints are real. Direct mode is the default; passphrase mode is the fallback, and the owner-facing UI SHOULD present it that way rather than as an equal choice.

---

## 5. Serialisation: universal link / app link

Phase 4. The same URL from §2, with the relay domain claimed via `apple-app-site-association` and Android App Links, so an installed app intercepts the invite and the browser is bypassed.

No payload change is required. That is the point of §1 existing.

Native clients inherit every obligation in §2.2, with one addition: iOS and Android clients MUST NOT persist `key` to the keychain or keystore without the same explicit opt-in described in §2.2, and MUST NOT include it in any crash report or diagnostic bundle.

---

## 6. Versioning

- A client encountering an unknown `v` MUST refuse and display a clear "this invite needs a newer version" message. It MUST NOT guess.
- Adding a field is a version increment.
- Payload version is independent of envelope version (encryption spec §8). They may diverge.

---

## 7. Test requirements

1. Round trip: object → URL → object, both modes
2. Round trip: object → QR → decode → object
3. **A test asserting that no HTTP request issued by the client contains `key` material in its URL, headers, or body.** This is the §2.1 guard. It is the single most important test in the client codebase.
4. Rejection of an unknown `v`
5. Rejection or explicit confirmation of an unrecognised `relay` origin
6. Passphrase unwrap against fixed vectors
7. Assertion that after load, `key` appears in no persistent browser storage
