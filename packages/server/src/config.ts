/*
 * Configuration, read from the environment exactly once, at the composition
 * root — never at import time.
 *
 * vitrina-server-architecture.md §2 gives `index.ts` the job of "read config → build adapters
 * → build use cases → buildServer → listen", so this file exports a function
 * rather than a populated object. The difference is not cosmetic: a
 * module-level `parseOrigin(requireEnv(...))` runs on import, which means every
 * test that so much as imports the HTTP adapter needs CLIENT_ORIGIN in its
 * environment. Failing fast on a missing origin is right; doing it before
 * `main()` has been entered is not.
 *
 * This file sits beside index.ts rather than under domain/, application/ or
 * adapters/, because it belongs to none of them — it is bootstrap.
 */

export type Config = {
  /** The single allowlisted browser origin for CORS. One per environment. */
  readonly clientOrigin: string;
  readonly host: string;
  readonly port: number;
  /**
   * The one server secret — api-sketch §8.2. Domain-separated into the auth
   * pepper and the decoy salt, and read from here by nothing but the
   * composition root: a second reader is a second place to fall back.
   */
  readonly serverSecret: Uint8Array;
  readonly databaseUrl: string;
};

type Env = Readonly<Record<string, string | undefined>>;

function requireEnv(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Bytes the server secret must have, at least — api-sketch §8.2. */
const SERVER_SECRET_MIN_BYTES = 32;

/**
 * The server secret, base64url. Absent or short is a hard failure before the
 * process listens, NEVER a generated substitute: generate-if-missing works
 * perfectly on an empty deployment and destroys login indistinguishability on
 * every restart, with nothing failing while it happens (brief §6 #17).
 *
 * base64url rather than hex, so one decoder serves this and schema §6's tokens.
 */
function parseServerSecret(raw: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error(
      "VITRINA_SERVER_SECRET must be base64url: the alphabet is A-Z a-z 0-9 - _, with no padding",
    );
  }
  const decoded = Buffer.from(raw, "base64url");
  if (decoded.byteLength < SERVER_SECRET_MIN_BYTES) {
    // The length, never the value: this message reaches an operator's terminal.
    throw new Error(
      `VITRINA_SERVER_SECRET decodes to ${decoded.byteLength} bytes; at least ${SERVER_SECRET_MIN_BYTES} are required`,
    );
  }
  return decoded;
}

/**
 * Parse and normalise a browser origin.
 *
 * `Access-Control-Allow-Origin` must be a bare origin with no trailing slash.
 * A value carrying a path, a query or a trailing slash produces a header that
 * never matches, and the browser reports it as an opaque CORS failure with
 * nothing logged server-side — so it is validated here, at boot, where the
 * error names the actual problem.
 */
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

function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535: ${raw}`);
  }
  return port;
}

export function loadConfig(env: Env = process.env): Config {
  return {
    clientOrigin: parseOrigin(requireEnv(env, "CLIENT_ORIGIN")),
    serverSecret: parseServerSecret(requireEnv(env, "VITRINA_SERVER_SECRET")),
    databaseUrl: requireEnv(env, "DATABASE_URL"),
    // 0.0.0.0 so the process is reachable from outside its container.
    host: env["HOST"] ?? "0.0.0.0",
    port: parsePort(env["PORT"] ?? "3000"),
  };
}
