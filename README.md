# Vitrina

Share photos of your children with the people you choose, without the photos becoming files on their devices or in someone else's cloud.

> **Status: Phase 0 — specification and foundations.** Nothing is usable yet. There is no application, no server, and no deployment. The encryption envelope is being implemented; everything else is a document.

---

## What this is

Parents living away from family share photos over WhatsApp and Telegram and are uneasy about it. Not because they distrust the people they're sending to, but because of what happens by default: the photo saves to the recipient's camera roll, syncs to their cloud backup, gets forwarded to a forty-person family group, and sits on a messaging company's servers indefinitely. Years later there are pictures of a five-year-old in places nobody chose.

Vitrina is built to defeat that. A parent uploads photos; the client encrypts them before they leave the device. The relay server stores ciphertext it cannot read. Recipients receive an invitation — a QR code or a passphrase — open a viewer in their browser, and see the images without any file being written to their device.

## What it does and does not do

Being precise about this is a product requirement, not modesty.

**It does:**

- Encrypt every image on the parent's device before upload. The server never holds a key and cannot decrypt anything it stores.
- Strip GPS coordinates and all camera metadata before encryption.
- Render images without ever writing a file to the recipient's filesystem, camera roll, or downloads — so nothing enters their cloud backup and there is no file object to forward.
- Let the parent revoke a recipient's access at any time.
- Restrict viewing to people the parent explicitly invited.

**It does not:**

- Prevent screenshots. It cannot.
- Prevent someone photographing the screen with another phone.
- Prevent a technically capable recipient from extracting what is displayed.
- Constitute DRM or make images "uncopyable."

The threat being defended against is **accident, not attack** — the automatic save, the reflexive forward, the silent cloud sync. Friction reliably defeats accident and never defeats determination. Any description of this project that implies otherwise is wrong and should be corrected.

## How it works

```
Parent device                Relay server              Recipient browser
(encrypts locally)  ──────►  (ciphertext only)  ─────►  (decrypts in memory)
       │                                                        ▲
       └──────────── access key: QR or passphrase ──────────────┘
                     (never touches the relay)
```

Images are downscaled and stripped of metadata client-side, then encrypted into a chunked envelope format. Each chunk is independently decryptable, which means any chunk can be fetched by byte range and decrypted on its own — the property that will make video seeking possible without a format change.

Full detail in `spec/`.

## Repository layout

| Path               | What                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `crates/envelope/` | Rust implementation of the encryption envelope, compiled to WASM. The one implementation all clients share. |
| `spec/`            | Canonical specifications and test vectors                                                                   |
| `packages/web/`    | SvelteKit client — owner and recipient                                                                      |
| `packages/server/` | The HTTP API. Deliberately boring; holds no keys.                                                           |
| `packages/shared/` | Types shared across web and server                                                                          |
| `infra/`           | Migrations, local Postgres and object storage, CI                                                           |

## Documentation

`spec/` is canonical and wins over anything inferred from the code.

| Document                     | Purpose                                                     |
| ---------------------------- | ----------------------------------------------------------- |
| `vitrina-project-brief.md`   | Threat model, promises, non-negotiables, open decisions     |
| `vitrina-encryption-spec.md` | The envelope format. Implementable from the document alone. |
| `vitrina-invite-spec.md`     | Invite payload and its serialisations                       |
| `vitrina-roadmap.md`         | Phases                                                      |
| `vitrina-phase-0-plan.md`    | Current work                                                |

The encryption specification is deliberately written so a third party could implement a conforming client without reading this source. If it's ambiguous, that's a bug in the document.

## Development

Requires Rust with the `wasm32-unknown-unknown` target, Node with `pnpm`, and Docker for local Postgres and S3-compatible object storage.

```bash
pnpm install
pnpm infra:up           # one command; brings up the whole local stack
```

`pnpm infra:up` is `docker compose up -d`. It brings up:

| Service            | Where                    | What                                                                                 |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------ |
| `vitrina-postgres` | `localhost:5432`         | Postgres 15. Database `vitrina`, user `admin`, password `password`.                   |
| `seaweedfs`        | `localhost:8333`         | SeaweedFS S3 gateway — the S3-compatible object store that holds ciphertext.          |
| `createbucket`     | — (one-shot, then exits) | Waits for the gateway, then creates the `vitrina-media` bucket. Exiting `0` is done.  |

Credentials for the object store live in `s3-config.json` and are shared by the
gateway, the bucket seeder, and the tests, so there is one source of truth. They
are local development credentials with no production counterpart.

`pnpm infra:down` stops the stack. Volumes are named (`pgdata`, `seaweed-data`)
and survive it; `docker compose down -v` is the way to start from empty.

### Tests

```bash
cargo test              # envelope crate
pnpm test               # TypeScript — no Docker needed
pnpm test:infra         # object store — requires the stack to be up
```

`pnpm test:infra` is deliberately **not** part of `pnpm test`. It talks to a live
SeaweedFS over the network, so it needs `pnpm infra:up` first and would otherwise
make the ordinary suite fail on a machine without Docker running. What it checks
is `infra/object-store.test.mjs`: that a presigned URL round-trips bytes
unaltered, that byte-range GETs return exactly the right chunk (arithmetic
offsets, first / middle / partial-final), and that unsigned, tampered, and
expired URLs are refused. Those are the transport-layer properties the chunked
envelope depends on.

It reads credentials from `s3-config.json`; `S3_ENDPOINT`, `S3_BUCKET`, and the
usual `AWS_*` variables override that if you point it at something else.

_(`pnpm test` has no TypeScript suites behind it yet — the packages are still empty.)_

## Status

- [ ] **Phase 0** — specs, repo foundations, envelope crate, test vectors
- [ ] **Phase 1** — v1: web, photos only
- [ ] **Phase 2** — hardening, GDPR, accessibility, abuse policy
- [ ] **Phase 3** — video
- [ ] **Phase 4** — native mobile

Phase 0 progress and exit criteria are tracked in `spec/vitrina-phase-0-plan.md`.

## Known limitations

Recorded in the brief rather than discovered later. The significant ones:

- Screenshots and screen photography cannot be prevented on any platform, and not at all on the web.
- Revocation is enforced by the server refusing to serve ciphertext. It is not cryptographic — a key already given cannot be un-given.
- Watermarking is applied client-side and is bypassable by editing the JavaScript. This is a deliberate trade: server-side watermarking would require a server that can decrypt.
- A browser cannot verify that the JavaScript it received matches this repository. This is the standing limitation of all browser-based end-to-end encryption and is not solved here.

## License

**None.** This repository has no LICENSE file, which means all rights are reserved and no permission to use, copy, modify, or distribute is granted. It is readable, not open source.

Licensing is an open decision (brief §12) and will be resolved per component before any external contribution is accepted.

## Contributing

Not open to contributions yet, for the reason above — accepting outside code before the license is settled would make relicensing impossible without every contributor's permission. Issues and correspondence are welcome.
