# @vitrina/web

```bash
pnpm --filter @vitrina/envelope build:wasm   # once, and after crates/ changes; needs the Rust toolchain
pnpm --filter @vitrina/web dev               # http://localhost:5173 — the origin packages/server allows
pnpm --filter @vitrina/web test
pnpm --filter @vitrina/web lint
pnpm --filter @vitrina/web build             # → packages/web/build/
```

`vite dev` and `vite build` also need `src/lib/owner/passwords-top-100k.txt` (the owner supplies it: one password per line, UTF-8) and `src/lib/keys/owner-open.ts` (the owner's key functions, typed in `owner-types.ts`).

`VITE_API_ORIGIN` comes from `.env` for local work; a deployment build sets it in the environment.
