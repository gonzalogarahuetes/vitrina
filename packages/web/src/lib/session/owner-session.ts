/*
 * The one module that may touch sessionStorage (eslint.config.js). It holds
 * the owner token and its `expires_at`, and nothing else, ever (brief §12,
 * flows §1.1). No email, no key, no KEK, no proof, no password. The expiry is
 * stored because unlock never receives it, and without it no warning is
 * possible after a reload (flows §3.12).
 *
 * Values are checked on the way in and on the way out. A stored value of the
 * wrong shape is cleared, and the page treats it as no token at all.
 */

export type StoredSession = {
  /** 43 characters of base64url (api-sketch §7.5). */
  readonly token: string;
  /** RFC 3339 UTC with a trailing Z. */
  readonly expiresAt: string;
};

/** The store the owner session takes, so tests can inject one. */
export type SessionStore = {
  read(): StoredSession | null;
  write(s: StoredSession): void;
  clear(): void;
};

export const TOKEN_KEY = "vitrina:owner:token";
export const EXPIRES_KEY = "vitrina:owner:expires_at";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export function isStoredSession(s: { token: unknown; expiresAt: unknown }): s is StoredSession {
  return (
    typeof s.token === "string" &&
    TOKEN.test(s.token) &&
    typeof s.expiresAt === "string" &&
    RFC3339_UTC.test(s.expiresAt) &&
    !Number.isNaN(Date.parse(s.expiresAt))
  );
}

/** Storage as the Web Storage interface, so tests can pass a stand-in. */
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function sessionStore(storage: () => StorageLike = () => sessionStorage): SessionStore {
  const clear = (): void => {
    try {
      storage().removeItem(TOKEN_KEY);
      storage().removeItem(EXPIRES_KEY);
    } catch {
      // Storage unavailable: there is nothing to clear.
    }
  };
  return {
    read() {
      let token: string | null, expiresAt: string | null;
      try {
        token = storage().getItem(TOKEN_KEY);
        expiresAt = storage().getItem(EXPIRES_KEY);
      } catch {
        return null;
      }
      if (token === null && expiresAt === null) return null;
      const s = { token, expiresAt };
      if (isStoredSession(s)) return s;
      clear();
      return null;
    },
    write(s) {
      if (!isStoredSession(s)) throw new TypeError("refusing to store a malformed session");
      // Two fields, written explicitly: nothing else on `s` can reach storage.
      try {
        storage().setItem(TOKEN_KEY, s.token);
        storage().setItem(EXPIRES_KEY, s.expiresAt);
      } catch {
        // Storage refused (private mode quota, say). The session still works
        // in this page and is lost on reload, which leads to sign-in.
        clear();
      }
    },
    clear,
  };
}
