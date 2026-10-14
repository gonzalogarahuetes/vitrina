# @vitrina/web

```bash
pnpm --filter @vitrina/envelope build:wasm   # once, and after crates/ changes; needs the Rust toolchain
pnpm --filter @vitrina/web dev               # http://localhost:5173 — the origin packages/server allows
pnpm --filter @vitrina/web test
pnpm --filter @vitrina/web lint
pnpm --filter @vitrina/web build             # → packages/web/build/
```

`VITE_API_ORIGIN` comes from `.env` for local work; a deployment build sets it in the environment.
