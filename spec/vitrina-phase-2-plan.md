# Vitrina — Phase 2 Plan

**Status:** Draft · 18 November 2026 · items 1–3 done
**Companion to:** `vitrina-project-brief.md` (canonical) and `vitrina-roadmap.md` (Phase 2)

A list, kept current: one row per item, its order, who does it, whether it needs staging, and its status. Decisions are recorded under the item, with their date, the day they are made. When an item lands, its status changes and its decisions stay. No prose beyond that.

**Phase 2 has two parts, decided 16 November 2026:** **2a, Hardening** (the roadmap's Phase 2), then **2b, Features**. Phase 3 stays video only.

**Rules for every item** (`CLAUDE.md`, `deploy/README.md` section 3):

- One item at a time, each in its own worktree and branch, reviewed in the coordinating chat before merge.
- **One-shot** when the work is decided and "done" is a set of green commands: a terminal agent runs the prompt and reports at the end. **Interactive** when it needs decisions along the way: a terminal session I stay in. **Owner** for the cryptographic layer (`CLAUDE.md`, Ownership). Every prompt is written and every report reviewed in the coordinating chat.
- **Staging** (`deploy/README.md` section 5) before any release that adds a migration or touches accounts, keys or deletion. Every migration works with the previous release's code.
- Testers get two lines after anything they can see.
- Nothing from Phase 3 or 4. An item that seems to need it stops and is raised.

---

# 2a — Hardening

## Before the first migration release

| #   | Item                        | Scope                                                | Status |
| --- | --------------------------- | ---------------------------------------------------- | ------ |
| R1  | Disaster-recovery rehearsal | `deploy/README.md` section 1b, on a throwaway server | Open   |

## A. What the testers hit now

| #   | Item              | Scope                                                                         | Who         | Staging | Status |
| --- | ----------------- | ----------------------------------------------------------------------------- | ----------- | ------- | ------ |
| 1   | Browser Back      | Back goes back one screen on both paths                                       | One-shot    | No      | Done   |
| 2   | Upload progress   | Per-photo and overall progress during upload (`vitrina-client-flows.md` §3.6) | One-shot    | No      | Done   |
| 3   | JPEG quality      | Measured on real photos from both phones; one number, chosen by eye and size  | Interactive | No      | Done   |
| 4   | Actionable errors | Every error screen says what the person can do next (roadmap, Phase 2)        | Interactive | No      | —      |

**1 — decided 16 November 2026:** `history.state` holds a marker from a fixed set and nothing else (no ids); the URL never changes. Back runs the screen's own back or cancel method, guards included. Top levels (owner album list, recipient grid) leave the app. Dialogs and sheets close on Back, including Unlock's sign-out sheet; Unlock itself adds no entry. Forward reopens nothing. Phone gesture check before tagging.

**2 — decided 16 November 2026:** a batch summary ("3 of 12", a bar, "keep this page open") while anything is queued or in flight; an item counts only on the server's `ready` or a failure, never on a PUT's return. A batch ending with anything not `ready` leaves one closing line until the album is left or a new batch starts. `beforeunload` while a batch runs. In-progress cells are no longer live regions. No per-photo percentage: it needs `XMLHttpRequest` beside `fetch`; revisit only if testers on weak connections still report it.

**3 — decided 17 November 2026:** photos 0.75 (was 0.85), thumbnails 0.70 (was 0.80). No visible difference between 0.70 and 0.90 in Chrome on Android or Safari on macOS; 0.75 keeps one step of margin, because the eye test used a low-sharpness phone and a quality cannot be changed after upload. Numbers in `packages/web/scripts/jpeg-quality/RESULTS.md`.

## B. Accounts and keys

| #   | Item                    | Scope                                                                                        | Who                 | Staging | Status |
| --- | ----------------------- | -------------------------------------------------------------------------------------------- | ------------------- | ------- | ------ |
| 5   | Recovery key            | A second `owner_keys` row wrapping `K_master` (encryption spec §6.6); shown once at creation | Owner + interactive | Yes     | —      |
| 6   | Password change         | Re-wrap `K_master` under a new KEK; other sessions signed out                                | Owner + interactive | Yes     | —      |
| 7   | "This is my device"     | Opt-in persistence for owners; only after 6, its one remedy for a lost device (brief §12)    | Interactive         | Yes     | —      |
| 8   | Recipient re-invitation | A new invite for someone already in the album, without revoking blind (roadmap, Phase 2)     | Interactive         | Maybe   | —      |

## M. Album membership — before C

| #   | Item             | Scope                                                                                                                                                                                                                           | Who         | Staging | Status |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------- | ------ |
| 9   | Membership model | An album has members, not one `owner_id`. The decision and its first, additive migration (a members table, one row per existing album), so deletion in C is written once, against membership. Access checks move in 2b, item 21 | Interactive | Yes     | —      |

**9 — decided 16 November 2026:** every member of an album can do everything the creator can. No separate permissions. Open, for the design session: the two consequences of that rule — any member can delete the album for everyone, and any member can remove another, the creator included.

## C. Deletion and lifecycle

| #   | Item                 | Scope                                                                                              | Who         | Staging | Status |
| --- | -------------------- | -------------------------------------------------------------------------------------------------- | ----------- | ------- | ------ |
| 10  | Album deletion       | With erasure: objects first, then rows (api-sketch §4.2, §9.10). Against membership (item 9)       | Interactive | Yes     | —      |
| 11  | Account deletion     | With erasure, same order; today done by hand. An album with another member survives                | Interactive | Yes     | —      |
| 12  | Stalled-item sweep   | Uploads stuck pending, removals stuck pending erasure, orphaned partial objects (api-sketch §9.10) | One-shot    | Yes     | —      |
| 13  | Access-log retention | A retention period and the floor date the read routes need (api-sketch §11.10; schema §3)          | Interactive | Yes     | —      |
| 14  | Storage lifecycle    | What is kept, for how long, including backups                                                      | Interactive | No      | —      |
| 15  | GDPR                 | Privacy policy, lawful basis, retention, erasure. Written after 10–14, from what they decided      | Interactive | No      | —      |

## D. Limits and operations

| #   | Item                 | Scope                                                                                         | Who         | Staging | Status |
| --- | -------------------- | --------------------------------------------------------------------------------------------- | ----------- | ------- | ------ |
| 16  | Accessibility review | With a real elderly user; before the redesign (item 26), so it tells the redesign what to fix | You         | No      | —      |
| 17  | Quotas               | Upload limits per owner (api-sketch §9.10)                                                    | Interactive | Maybe   | —      |
| 18  | Limiter tuning       | The rate limits, with numbers from real use (api-sketch §11.10)                               | One-shot    | No      | —      |
| 19  | Observability        | Knowing when uploads fail without being told                                                  | Interactive | No      | —      |
| 20  | The abuse question   | Brief §11. Gates public availability only, not this group                                     | Interactive | —       | —      |

## Technical debt

| #   | Item                      | Scope                                                                                                                                                                                                                               | Who      | Status |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| T1  | Independent vector checks | Remaining categories 9 and 16–19; protocol vectors 4 and 7                                                                                                                                                                          | One-shot | —      |
| T2  | `markReady` misreport     | —                                                                                                                                                                                                                                   | One-shot | —      |
| T3  | Download stalled mid-body | A GET that stalls part-way through the body                                                                                                                                                                                         | One-shot | —      |
| T4  | Orientation guard         | When the file's EXIF orientation is 5–8, `decode()` requires a swapped shape, else falls back or fails: `plausible()` accepts a result with the tag ignored. Found 17 November 2026; untested on Android Chrome with a tagged photo | One-shot | —      |

## Decided not to build

**Per-invite device counts** (invite spec §8.5, roadmap Phase 2) — **decided 16 November 2026.** Recipients have no device identity: the invite lives in `sessionStorage` and dies with the tab, so every tab would count as a device. A real count needs a persistent identifier on recipients' devices, which is a tracking identifier; inferring it from IP or browser is unreliable on phones and is personal data. The count would alarm on a grandparent with two tabs and miss a forward opened once. Forwarding is answered by passphrase mode, revocation and re-invitation, and the access log.

---

# 2b — Features

## G. Sharing

| #   | Item          | Scope                                                                                                                                                                                           | Who                 | Staging | Status |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------- | ------ |
| 21  | Co-owners     | A co-owner invite hands over `K_album` as an invite does (`K_invite`, encryption spec §6.1); the new member wraps it under their own `K_master`. No new primitive. Design session first         | Owner + interactive | Yes     | —      |
| 22  | Reactions     | One reaction (a heart), visible to the owners only, beside the access log. Not encrypted: it says little more than the view the relay already records                                           | Interactive         | Yes     | —      |
| 23  | Text comments | To the owners only. Encrypted under `K_album` like the metadata blob — no format change, to be confirmed against encryption spec §2 and §5 first. Revocation stops writing; erasure covers them | Interactive         | Yes     | —      |

Item 21 includes moving every access check from `albums.owner_id` to membership (item 9). Recipients' writes (22, 23) are new: today an invite token only reads.

## F. When there is room

| #   | Item                         | Scope                                                                                                                    | Who         | Staging | Status |
| --- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------- | ------- | ------ |
| 24  | Caption editing              | After upload; re-encrypts the metadata blob (encryption spec §7)                                                         | Interactive | No      | —      |
| 25  | "New photos" notice          | For recipients, carrying no photo                                                                                        | Interactive | Maybe   | —      |
| 26  | Redesign and Lirio           | New layout, logo, the Lirio name in the UI. Brief §3 binds it; brief §16 copy goes back through review in both languages | Interactive | No      | —      |
| 27  | Background uploads           | Uploads that survive leaving the screen                                                                                  | Interactive | No      | —      |
| 28  | Licences link for recipients | Optional                                                                                                                 | One-shot    | No      | —      |
| 29  | More languages               | Catalan, French, Italian, each gated on a fluent reader (brief §15.3), with its wordlist                                 | Interactive | No      | —      |
