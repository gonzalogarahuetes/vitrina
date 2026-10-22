/*
 * The recipient's one stored value, and the second module that may touch
 * sessionStorage (eslint.config.js). Decided 20 October 2026 on the phone test
 * in scripts/tab-reload-test/RESULTS.md: flows §4.7, invite spec §2.2 step 4.
 *
 * What it holds: the invite fragment exactly as read — `v`, the album id, the
 * token, and for a QR invite `k`, which is K_invite. Nothing derived from it,
 * ever. K_album is never stored: a reload unwraps it again, and a revoked
 * invite's K_invite unwraps nothing because the relay refuses the wrapping
 * (encryption spec §6.4).
 *
 * Why sessionStorage and nothing longer-lived: it is per tab, survives a
 * reload, and is gone when the tab closes — measured on both target phones.
 * Anything that survives closing the tab is invite spec §2.2's open "remember
 * on this device" decision, and is not this module.
 *
 * Only a fragment parseInvite accepted is written (entry.ts). Every read and
 * write is guarded: storage can be unavailable, and then a reload is the dead
 * page, as it was before this module existed.
 */

export const INVITE_KEY = "vitrina:recipient:invite";

/** Storage as the Web Storage interface, so tests can pass a stand-in. */
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type InviteStore = {
  /** The stored fragment, or null when there is none or storage is unavailable. */
  read(): string | null;
  write(fragment: string): void;
  clear(): void;
};

export function inviteStore(storage: () => StorageLike = () => sessionStorage): InviteStore {
  const clear = (): void => {
    try {
      storage().removeItem(INVITE_KEY);
    } catch {
      // Storage unavailable: there is nothing to clear.
    }
  };
  return {
    read() {
      try {
        return storage().getItem(INVITE_KEY);
      } catch {
        return null;
      }
    },
    write(fragment) {
      try {
        storage().setItem(INVITE_KEY, fragment);
      } catch {
        // Refused (quota, private mode): this page still works, and a reload
        // is the dead page. A stale entry from an earlier invite must not
        // survive in place of this one.
        clear();
      }
    },
    clear,
  };
}
