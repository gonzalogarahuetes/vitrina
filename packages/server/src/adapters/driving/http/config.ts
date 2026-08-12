// src/config.ts
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function parseOrigin(raw: string): string {
  const url = new URL(raw); // throws on malformed input
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error(`CLIENT_ORIGIN must be https unless localhost: ${raw}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`CLIENT_ORIGIN must be an origin, not a URL: ${raw}`);
  }
  return url.origin; // normalised, no trailing slash
}

export const config = {
  clientOrigin: parseOrigin(requireEnv("CLIENT_ORIGIN")),
} as const;
