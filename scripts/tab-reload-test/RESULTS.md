# Tab reload test — results

Page: `scripts/tab-reload-test/index.html`. Status: **complete** — Android 2026-10-13, iPhone 2026-10-20 (QR row not run). Fill every row from the page's Results box (screenshot or "Copy results as text").

## How to run

1. Host `index.html` on a plain static HTTPS host at its own URL — not inside an iframe, not a preview, not a claude.ai artifact. Any of: Cloudflare Pages, Netlify drop, GitHub Pages, an S3 bucket behind HTTPS. Path can be anything; the page builds its own test link from wherever it is served.
2. Open the hosted page once on a laptop. Copy the test link it shows (the fragment is fixed dummy data: `a` 22 chars, `t` 43, `k` 43; full link ≈ 150 chars). Generate a QR for the Camera path from that exact link, e.g. `npx qrcode-terminal "<link>"` or any QR tool.
3. Send the link via WhatsApp and Telegram to each phone. For the iPhone, send the friend the link plus this message:

   > Open the link, read the box at the top, and do steps 1–5 on the page. Tap "Start" before each step. Step 2 only counts once the page says it reloaded — leave the browser for a while with heavy apps (camera video, games) if it doesn't. At the end, tap "Finish this run" and send me a screenshot of the Results box. Then do it again from the other app, and once by scanning the QR with the Camera.

4. One run per (browser × entry path). Each fresh open of the link starts a new run; earlier runs on the same browser stay under "Previous runs".

## Reading the page's output into the table

- **Fragment on first open**: the "Link details present on first open" row. `yes` / `no` / `altered`.
- **App switch → reload / Pull-to-refresh / Close & reopen**: `intact` / `gone` / `changed` / `n/a`. Also copy the load `type` shown next to it and, on Android Chrome, `discarded`. If the row still says "waiting — no reload yet", the discard never happened: the row is **not done**, not "intact".
- A "came back from the memory cache" note in the banner means a bfcache restore. It is not a reload. Ignore it.
- **Actually opened in**: the "What does this window look like?" answer plus the UA guess line. WhatsApp/Telegram settings may send the link to the system browser; record what happened, not what was expected.
- **UA**: the last row of the Results box.

## Table

| Device | Entry path | Actually opened in | Fragment on first open | App switch → reload: storage | Pull-to-refresh: storage | Close & reopen tab: storage | UA |
|---|---|---|---|---|---|---|---|
| Android (Helio G35) | Chrome, link pasted | Chrome, normal tab | yes | not triggered | intact (reload, discarded=false) | **gone** (navigate) | Android 10; Chrome/148.0.0.0 |
| Android (Helio G35) | WhatsApp tap | Chrome, normal tab (WhatsApp handed off to system browser) | yes | not triggered | intact (reload, discarded=false) | **gone** (navigate) | Android 10; Chrome/148.0.0.0 |
| Android (Helio G35) | Telegram tap | Chrome Custom Tab inside Telegram (UA has no `wv`) | yes | not triggered | intact (reload, discarded=false) | n/a (no tabs) | Android 11; Chrome/152.0.7977.87 — see note |
| Android (Helio G35) | Camera QR scan | Chrome, normal tab | yes | not triggered | intact (reload, discarded=false) | **gone** (navigate) | Android 10; Chrome/148.0.0.0 |
| iPhone (iOS 18.7, Safari 27.0.1) | Safari, link pasted | Safari, normal tab | yes | not triggered | intact (reload) | **gone** (navigate) | iPhone OS 18_7; Version/27.0.1 Mobile/15E148 |
| iPhone (iOS 18.7, Safari 27.0.1) | WhatsApp tap | Safari, normal tab (WhatsApp handed off to Safari) | yes | not triggered | intact (reload) | **gone** (navigate) | iPhone OS 18_7; Version/27.0.1 Mobile/15E148 |
| iPhone (iOS 18.7, Safari 27.0.1) | Telegram tap | Telegram in-app view, own storage profile (page run count restarted at 1; `Mobile/24A446` token differs) | yes | not triggered | intact, but logged as `navigate` not `reload` — in-app view has no pull-to-refresh, so this was its reload/reopen control | not done (no tabs; should read n/a) | iPhone OS 18_7; Version/27.0.1 Mobile/24A446 |
| iPhone | Camera QR scan | not run | | | | | |

For each storage cell record `intact` / `gone` / `changed` / `n/a` + the load type, e.g. `intact (reload, discarded=true)`.

## Notes

- `location.reload()` and the reload button are **not** a discard. Only step 2 on the page measures a discard, and only when it reports a new load with no Start-tap in between.
- A row with "not done" in step 2 is a legitimate outcome (device never discarded the tab). Note how long/how hard it was tried.
- Android, 2026-10-13: four runs (page runs 1–4). Fragment arrived intact on every entry path, including the camera QR scan. Ordinary reload keeps sessionStorage. **"Reopen closed tab" in Chrome 148 came back as `navigate` with sessionStorage gone, three times out of three** — the restore path does not carry sessionStorage on this device, so the proposed fix leaves a dead page there regardless of discards.
- Android discard: not triggered in four attempts (videos, several apps, minutes away). Chrome kept the tab resident each time; `pageshow.persisted` never fired either, so these were plain foreground returns. Not forced via Developer options. Row stays "not triggered".
- Android UA inconsistency: runs 1, 3, 4 report Android 10 / Chrome 148; the Telegram run reports Android 11 / Chrome 152. Same phone, so the Custom Tab appears to be served by a different Chrome build (Beta, or a second install). Its storage profile is therefore not the one the other three runs measured. Unresolved; check Telegram → Settings → Chat Settings → In-app browser.
- iPhone, 2026-10-20: three runs, friend-operated. Fragment arrived on every path tried. Ordinary reload keeps sessionStorage in Safari and in Telegram's view. **"Reopen closed tab" in Safari came back `navigate` with sessionStorage gone, twice out of two** — same shape as Chrome on Android. Discard never triggered. QR not attempted. No Chrome on the device, which was not a planned row anyway.
- iPhone storage profiles: the Telegram run's page numbering restarted at run 1 while Safari runs were 2 and 4, confirming the Telegram view has its own localStorage/sessionStorage, separate from Safari. Run 3 is missing from both: an abandoned attempt in Safari.
- Cross-device result: **on both Chrome 148/Android and Safari 27/iOS, reopening a closed tab does not restore sessionStorage** (`navigate`, storage gone). Ordinary reload does. Discard-reload could not be triggered on either device. The sessionStorage fallback as proposed therefore fixes refresh but not reopen, and the discard case remains unmeasured.
- iOS in-app browsers (SFSafariViewController in WhatsApp, Telegram's web view) have no tabs to close/reopen — expect `n/a` there.
