import { describe, expect, it } from "vitest";
import { EnvelopeUnavailable } from "$lib/envelope";
import type { UnwrapError } from "$lib/keys/types";
import {
  ALBUM_ID,
  FakePicture,
  INVITE_KEY,
  INVITE_KEY_B64,
  PASSPHRASE,
  PASSPHRASE_WORDS,
  PASS_FRAGMENT,
  QR_FRAGMENT,
  TOKEN,
  harness,
  media,
  memoryStore,
  seal,
  paths,
  settle,
  type Sent,
} from "./harness.test-support";
import { captureInvite, takeCapturedInvite } from "./entry";
import { encodeBase64url } from "@vitrina/shared";
import { uuidToBytes } from "$lib/ids";

const METADATA = `/v1/albums/${ALBUM_ID}/metadata`;
const assetsOf = (sent: readonly Sent[]) => paths(sent).filter((p) => p.endsWith("/asset"));

async function toGrid(h: ReturnType<typeof harness>, fragment = QR_FRAGMENT) {
  h.session.start(fragment);
  await settle();
  if (fragment === PASS_FRAGMENT) {
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    await settle();
  }
  expect(h.screen().kind).toBe("onboarding");
  h.session.enterGrid();
  await settle();
}

/** A QR invite whose K_invite bytes the test keeps a handle on, to see them zeroed. */
function heldInvite() {
  const held = Uint8Array.from(INVITE_KEY);
  return { held, invite: { mode: "qr" as const, albumId: uuidToBytes(ALBUM_ID), token: TOKEN, inviteKey: held } };
}

const albumScreen = (h: ReturnType<typeof harness>) => {
  const s = h.screen();
  if (s.kind !== "album") throw new Error(`expected the album, got ${s.kind}`);
  return s;
};

// ── Settled point 1 and invite spec §2.1 / §7 items 3 and 7 ───────────────

describe("the fragment is read, then stripped, then — only then — requests", () => {
  it("strips before the first request, and parse sees the fragment exactly", async () => {
    const h = harness();
    const replaced: { state: unknown; url: string }[] = [];
    const history = {
      state: { "sveltekit:history": 1 },
      replaceState(state: unknown, _: string, url: string) {
        h.events.push("strip");
        replaced.push({ state, url });
      },
    };
    captureInvite({ pathname: "/v/", search: "", hash: QR_FRAGMENT }, history, memoryStore());
    expect(h.events).toEqual(["strip"]);
    h.session.start(takeCapturedInvite());
    await settle();

    expect(h.events[0]).toBe("strip");
    expect(h.events[1]).toBe("parse");
    expect(h.events.slice(2).every((e) => e.startsWith("request "))).toBe(true);
    expect(h.parsed).toEqual([QR_FRAGMENT]);
    expect(replaced).toEqual([{ state: { "sveltekit:history": 1 }, url: "/v/" }]);
  });

  it("is handed over once: a second take is empty, and empty is the dead page", async () => {
    captureInvite({ pathname: "/v/", search: "", hash: QR_FRAGMENT }, { state: null, replaceState: () => undefined }, memoryStore());
    expect(takeCapturedInvite()).toBe(QR_FRAGMENT);
    const h = harness();
    h.session.start(takeCapturedInvite());
    await settle();
    expect(h.screen().kind).toBe("dead");
    expect(h.sent).toEqual([]);
  });

  it("leaves other paths alone", () => {
    let calls = 0;
    const store = memoryStore(QR_FRAGMENT);
    captureInvite({ pathname: "/", search: "", hash: "#x" }, { state: null, replaceState: () => void calls++ }, store);
    expect(calls).toBe(0);
    expect(takeCapturedInvite()).toBe("");
    expect(store.writes).toEqual([]);
  });
});

// ── Flows §4.7: a reload of the same tab continues ────────────────────────

describe("the tab keeps a valid fragment, and only a valid one (flows §4.7)", () => {
  const strip = { state: null, replaceState: () => undefined };

  it("stores a QR fragment exactly as read, after stripping it", () => {
    const store = memoryStore();
    const order: string[] = [];
    captureInvite({ pathname: "/v/", search: "", hash: QR_FRAGMENT }, { state: null, replaceState: () => void order.push("strip") }, {
      ...store,
      write: (f: string) => {
        order.push("store");
        store.write(f);
      },
    });
    expect(order).toEqual(["strip", "store"]);
    expect(store.writes).toEqual([QR_FRAGMENT]);
    expect(takeCapturedInvite()).toBe(QR_FRAGMENT);
  });

  it("stores a passphrase fragment too: the token and album, no key", () => {
    const store = memoryStore();
    captureInvite({ pathname: "/v/", search: "", hash: PASS_FRAGMENT }, strip, store);
    expect(store.writes).toEqual([PASS_FRAGMENT]);
    expect(store.value()).not.toContain("k=");
    takeCapturedInvite();
  });

  for (const [what, fragment] of [
    ["a malformed fragment", "#v=1&a=nope"],
    ["a newer-version fragment", "#v=2&x=y"],
    ["a fragment with an unknown field", `${PASS_FRAGMENT}&x=1`],
  ] as const) {
    it(`never stores ${what}, and still hands it to the session`, () => {
      const store = memoryStore();
      captureInvite({ pathname: "/v/", search: "", hash: fragment }, strip, store);
      expect(store.writes).toEqual([]);
      expect(takeCapturedInvite()).toBe(fragment);
    });
  }

  it("on a reload — no fragment — hands over the stored one", () => {
    captureInvite({ pathname: "/v/", search: "", hash: "" }, strip, memoryStore(QR_FRAGMENT));
    expect(takeCapturedInvite()).toBe(QR_FRAGMENT);
  });

  it("on a reload with nothing stored, hands over nothing: the dead page", async () => {
    captureInvite({ pathname: "/v/", search: "", hash: "" }, strip, memoryStore());
    const h = harness();
    h.session.start(takeCapturedInvite());
    await settle();
    expect(h.screen()).toEqual({ kind: "dead" });
    expect(h.sent).toEqual([]);
  });

  it("a QR reload unwraps again: back on onboarding, through /recipient/key, with the stored K_invite", async () => {
    captureInvite({ pathname: "/v/", search: "", hash: "" }, strip, memoryStore(QR_FRAGMENT));
    const h = harness();
    h.session.start(takeCapturedInvite());
    await settle();
    expect(h.screen()).toEqual({ kind: "onboarding" });
    expect(paths(h.sent).slice(0, 2)).toEqual(["/v1/recipient/key", "/v1/recipient"]);
    expect(h.invitesOpened).toHaveLength(1);
  });

  it("a passphrase reload asks for the words again", async () => {
    captureInvite({ pathname: "/v/", search: "", hash: "" }, strip, memoryStore(PASS_FRAGMENT));
    const h = harness();
    h.album.kind = "passphrase";
    h.session.start(takeCapturedInvite());
    await settle();
    expect(h.screen()).toEqual({ kind: "passphrase", phase: "ready" });
  });
});

describe("which screens forget the stored invite (flows §4.6, §4.7)", () => {
  const cases: [string, (h: ReturnType<typeof harness>) => void, string, number][] = [
    ["revoked", (h) => h.override("/v1/recipient/key", h.err(403, "ACCESS_REVOKED")), "revoked", 1],
    ["not recognised", (h) => h.override("/v1/recipient/key", h.err(401, "UNAUTHENTICATED")), "not-recognised", 1],
    ["the dead page (a damaged link)", () => undefined, "dead", 1],
    ["device failed keeps it: a reload may recover", () => undefined, "device-failed", 0],
  ];
  for (const [what, arrange, screen, forgotten] of cases) {
    it(what, async () => {
      const outcome = screen === "dead" ? "damaged-link" : screen === "device-failed" ? "could-not-derive" : "ok";
      const h = harness({ inviteOpen: outcome });
      arrange(h);
      h.session.start(QR_FRAGMENT);
      await settle();
      expect(h.screen()).toEqual({ kind: screen });
      expect(h.forgotten()).toBe(forgotten);
    });
  }

  it("the newer-version screen and a malformed link forget it too", async () => {
    for (const f of ["#v=2&x=y", "#v=1&a=nope"]) {
      const h = harness();
      h.session.start(f);
      await settle();
      expect(h.forgotten()).toBe(1);
    }
  });

  it("an offline wait forgets nothing", async () => {
    const h = harness();
    h.override("/v1/recipient/key", "network");
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(h.forgotten()).toBe(0);
  });
});

// ── Flows §4.1 step 4: QR fetches the wrapping and unwraps under K_invite ─

describe("the QR open (encryption spec §6.1)", () => {
  it("fetches /recipient/key first, unwraps with the fragment's K_invite and the response, then /recipient", async () => {
    const h = harness();
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(paths(h.sent).slice(0, 2)).toEqual(["/v1/recipient/key", "/v1/recipient"]);
    expect(h.invitesOpened).toEqual([
      { inviteKey: Array.from(INVITE_KEY), material: { id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", kind: "qr", wrapped: "w".repeat(64), wrap_nonce: "n".repeat(32) } },
    ]);
    expect(h.screen()).toEqual({ kind: "onboarding" });
  });

  for (const [error, screen] of [
    ["damaged-link", "dead"],
    ["unusable-material", "not-recognised"],
    ["could-not-derive", "device-failed"],
  ] as const) {
    it(`${error} → ${screen}, with K_invite zeroed and no further request`, async () => {
      const h = harness({ inviteOpen: error });
      h.session.start(QR_FRAGMENT);
      await settle();
      expect(h.screen()).toEqual({ kind: screen });
      expect(Array.from(h.zeroedAt[0] ?? [])).toEqual(new Array(32).fill(0));
      expect(paths(h.sent)).toEqual(["/v1/recipient/key"]);
    });
  }

  it("a revoked QR invite is the revoked screen, and K_invite is zeroed without ever being used", async () => {
    const { invite, held } = heldInvite();
    const h = harness({ invite });
    h.override("/v1/recipient/key", h.err(403, "ACCESS_REVOKED"));
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "revoked" });
    expect(h.invitesOpened).toEqual([]);
    expect(Array.from(held)).toEqual(new Array(32).fill(0));
  });

  it("an offline wait before the unwrap keeps K_invite intact, and the retry opens it", async () => {
    const h = harness();
    h.override("/v1/recipient/key", "network");
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.invitesOpened).toEqual([]);
    h.session.retryOffline();
    await settle();
    expect(h.invitesOpened.map((o) => o.inviteKey)).toEqual([Array.from(INVITE_KEY)]);
    expect(h.screen()).toEqual({ kind: "onboarding" });
  });

  it("a QR answer with a KDF field is not the API's shape: retryable, never unwrapped", async () => {
    const h = harness();
    h.override("/v1/recipient/key", { status: 200, json: { id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", kind: "qr", wrapped: "w".repeat(64), wrap_nonce: "n".repeat(32), kdf_salt: "s".repeat(22) } });
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(h.invitesOpened).toEqual([]);
  });
});

/** Every spelling of K_invite and the passphrase that could leak. */
function keySpellings(): string[] {
  const std = INVITE_KEY_B64.replace(/-/g, "+").replace(/_/g, "/");
  const hex = Array.from(INVITE_KEY, (b) => b.toString(16).padStart(2, "0")).join("");
  return [INVITE_KEY_B64, std, hex, hex.toUpperCase(), JSON.stringify(Array.from(INVITE_KEY)), Array.from(INVITE_KEY).join(","), String.fromCharCode(...INVITE_KEY), `k=${INVITE_KEY_B64}`, PASSPHRASE, encodeURIComponent(PASSPHRASE), "tortilla"];
}

function assertNoKeyMaterial(sent: readonly Sent[]) {
  expect(sent.length).toBeGreaterThan(0);
  for (const s of sent) {
    const url = new URL(s.url);
    expect(url.hash, s.url).toBe("");
    expect(url.search, s.url).toBe("");
    expect(s.url).not.toContain(TOKEN);
    const where = [s.url, s.body, ...Object.entries(s.headers).flat()];
    for (const spelling of keySpellings()) for (const w of where) expect(w, `${spelling} in ${s.url}`).not.toContain(spelling);
    // The token travels as the bearer value and nowhere else.
    expect(s.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  }
}

describe("invite spec §7 item 3: no request carries key material in its URL, headers or body", () => {
  it("over the whole QR path: open, onboarding, grid, viewer, back, another photo", async () => {
    const h = harness();
    await toGrid(h);
    h.session.openViewer(0);
    await settle();
    h.session.closeViewer();
    h.session.openViewer(2);
    await settle();
    assertNoKeyMaterial(h.sent);
    expect(paths(h.sent)).toContain(METADATA);
    expect(assetsOf(h.sent)).toHaveLength(2);
  });

  it("over the whole passphrase path, a wrong attempt included", async () => {
    const h = harness();
    h.album.kind = "passphrase";
    h.session.start(PASS_FRAGMENT);
    await settle();
    h.session.submitPassphrase(["tortilla", "de", "patatas", "sin", "cebolla"]);
    await settle();
    expect(h.screen()).toEqual({ kind: "passphrase", phase: "wrong" });
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    await settle();
    h.session.enterGrid();
    await settle();
    h.session.openViewer(1);
    await settle();
    assertNoKeyMaterial(h.sent);
    expect(h.opened.map((o) => o.passphrase)).toEqual(["tortilla de patatas sin cebolla", PASSPHRASE]);
  });

  it("would catch the leak it exists for: a ? where the # belongs", () => {
    const leaked: Sent = { url: `https://api.vitrina.test/v/?k=${INVITE_KEY_B64}`, method: "GET", headers: { authorization: `Bearer ${TOKEN}` }, body: "" };
    expect(() => assertNoKeyMaterial([leaked])).toThrow();
  });
});

describe("invite spec §7 item 7: after load, the key is in no persistent browser storage", () => {
  it("writes the one sessionStorage entry flows §4.7 allows, and nothing else, over the whole path", async () => {
    const writes: string[] = [];
    const rec = (name: string) => (...args: unknown[]) => void writes.push(`${name} ${JSON.stringify(args)}`);
    const storage = (name: string) => ({ setItem: rec(`${name}.setItem`), getItem: () => null, removeItem: rec(`${name}.removeItem`), clear: rec(`${name}.clear`), key: () => null, length: 0 });
    const g = globalThis as Record<string, unknown>;
    const saved = new Map(["localStorage", "sessionStorage", "indexedDB", "caches", "cookieStore", "document", "name"].map((k) => [k, g[k]]));
    let cookie = "";
    g["localStorage"] = storage("localStorage");
    g["sessionStorage"] = storage("sessionStorage");
    g["indexedDB"] = { open: rec("indexedDB.open"), deleteDatabase: rec("indexedDB.deleteDatabase") };
    g["caches"] = { open: rec("caches.open"), delete: rec("caches.delete") };
    g["cookieStore"] = { set: rec("cookieStore.set") };
    g["document"] = {
      get cookie() {
        return cookie;
      },
      set cookie(v: string) {
        cookie = v;
        writes.push(`document.cookie ${v}`);
      },
    };
    const storageManager = { getDirectory: rec("navigator.storage.getDirectory"), persist: rec("navigator.storage.persist") };
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { value: { storage: storageManager, serviceWorker: { register: rec("serviceWorker.register") } }, configurable: true });
    // window.name survives navigations within a tab; history.state survives reloads and restores.
    g["name"] = "";
    let historyState: unknown = { "sveltekit:history": 1 };
    try {
      const h = harness();
      // The real store over the stubbed sessionStorage: the one write it may make.
      captureInvite({ pathname: "/v/", search: "", hash: QR_FRAGMENT }, {
        get state() {
          return historyState;
        },
        replaceState(state: unknown) {
          historyState = state;
        },
      });
      await toGrid(h, takeCapturedInvite());
      h.session.openViewer(0);
      await settle();
      h.session.dispose();

      // Flows §4.7's one entry, the fragment as read (K_invite, never K_album),
      // and nothing else in any storage.
      expect(writes).toEqual([`sessionStorage.setItem ${JSON.stringify(["vitrina:recipient:invite", QR_FRAGMENT])}`]);
      expect(cookie).toBe("");
      expect(g["name"]).toBe("");
      const persisted = JSON.stringify(historyState);
      for (const spelling of keySpellings()) expect(persisted).not.toContain(spelling);
      expect(persisted).not.toContain(TOKEN);
    } finally {
      for (const [k, v] of saved) g[k] = v;
      if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
    }
  });

  it("zeroes K_invite's bytes once the unwrap has run", async () => {
    const h = harness();
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.zeroedAt).toHaveLength(1);
    expect(Array.from(h.zeroedAt[0] ?? [])).toEqual(new Array(32).fill(0));
  });
});

// ── Settled point 3: album_opened matches a grid that was on screen ───────

describe("the metadata call is the album open", () => {
  it("is not made behind onboarding, and is made once on entering the grid", async () => {
    const h = harness();
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen().kind).toBe("onboarding");
    expect(paths(h.sent)).toEqual(["/v1/recipient/key", "/v1/recipient", `/v1/albums/${ALBUM_ID}`]);
    h.session.enterGrid();
    h.session.enterGrid();
    await settle();
    expect(paths(h.sent).filter((p) => p === METADATA)).toHaveLength(1);
    h.session.openViewer(0);
    await settle();
    h.session.closeViewer();
    await settle();
    expect(paths(h.sent).filter((p) => p === METADATA)).toHaveLength(1);
  });
});

// ── Settled point 4: thumbnails freely, full assets only when viewed ──────

describe("no full asset is fetched before its photo is opened", () => {
  it("fetches every ready thumbnail and no asset for the grid", async () => {
    const h = harness();
    await toGrid(h);
    expect(paths(h.sent).filter((p) => p.endsWith("/thumbnail"))).toHaveLength(3);
    expect(assetsOf(h.sent)).toEqual([]);
  });

  it("fetches exactly the opened photo, once, as bytes=0-, and none of its neighbours", async () => {
    const h = harness();
    await toGrid(h);
    h.session.openViewer(1);
    await settle();
    const assets = h.sent.filter((s) => s.url.endsWith("/asset"));
    expect(assets.map((s) => new URL(s.url).pathname)).toEqual([`/v1/media/${media(2).id}/asset`]);
    expect(assets[0]?.headers["range"]).toBe("bytes=0-");
    const v = albumScreen(h).viewer;
    expect(v?.phase).toBe("shown");
    expect((v?.picture as FakePicture).source).toBe(`asset ${media(2).id}`);
  });

  it("drops a fetch whose viewer was closed, and closes what it decoded", async () => {
    const h = harness();
    await toGrid(h);
    h.session.openViewer(0);
    h.session.closeViewer();
    await settle();
    expect(albumScreen(h).viewer).toBeNull();
    const asset = h.pictures.filter((p) => p.source.startsWith("asset"));
    expect(asset.every((p) => p.closed === 1)).toBe(true);
  });
});

// ── Settled point 5: bitmaps closed, handles freed, bytes zeroed ──────────

describe("memory leaves with the screen", () => {
  it("closes the full photo when the viewer closes", async () => {
    const h = harness();
    await toGrid(h);
    h.session.openViewer(0);
    await settle();
    const pic = albumScreen(h).viewer?.picture as FakePicture;
    h.session.closeViewer();
    expect(pic.closed).toBe(1);
  });

  it("frees the key and closes every picture on dispose", async () => {
    const h = harness();
    await toGrid(h);
    h.session.openViewer(0);
    await settle();
    h.session.dispose();
    expect(h.keys[0]?.freed).toBe(1);
    expect(h.pictures.every((p) => p.closed === 1)).toBe(true);
  });
});

// ── Settled point 10: hide anything not ready ─────────────────────────────

describe("only ready media are shown", () => {
  it("hides pending, processing and failed rows", async () => {
    const h = harness();
    h.album.media = [media(1, "pending"), media(2), media(3, "processing"), media(4, "failed"), media(5)];
    await toGrid(h);
    expect(albumScreen(h).items.map((i) => i.id)).toEqual([media(2).id, media(5).id]);
    expect(paths(h.sent).filter((p) => p.endsWith("/thumbnail"))).toHaveLength(2);
  });

  it("an album with nothing ready is the empty state", async () => {
    const h = harness();
    h.album.media = [media(1, "pending"), media(2, "processing")];
    await toGrid(h);
    const s = albumScreen(h);
    expect(s.phase).toBe("ready");
    expect(s.items).toEqual([]);
  });
});

// ── Settled point 8: error mapping ────────────────────────────────────────

describe("403 ACCESS_REVOKED anywhere is the revoked screen, and drops everything", () => {
  it("at the first call", async () => {
    const h = harness();
    h.override("/v1/recipient", h.err(403, "ACCESS_REVOKED"));
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "revoked" });
    expect(h.keys[0]?.freed).toBe(1);
  });

  it("mid-grid, on a thumbnail: key freed, every picture closed, title and label gone", async () => {
    const h = harness();
    h.override(`/v1/media/${media(3).id}/thumbnail`, h.err(403, "ACCESS_REVOKED"));
    await toGrid(h);
    expect(h.screen()).toEqual({ kind: "revoked" });
    expect(h.keys[0]?.freed).toBe(1);
    expect(h.pictures.length).toBeGreaterThan(0);
    expect(h.pictures.every((p) => p.closed === 1)).toBe(true);
    expect(JSON.stringify(h.session.current)).not.toMatch(/María|Verano/);
  });

  it("in the viewer", async () => {
    const h = harness();
    await toGrid(h);
    h.override(`/v1/media/${media(1).id}/asset`, h.err(403, "ACCESS_REVOKED"));
    h.session.openViewer(0);
    await settle();
    expect(h.screen()).toEqual({ kind: "revoked" });
    expect(h.keys[0]?.freed).toBe(1);
  });

  it("on the passphrase route, before anything is typed", async () => {
    const h = harness();
    h.album.kind = "passphrase";
    h.override("/v1/recipient/key", h.err(403, "ACCESS_REVOKED"));
    h.session.start(PASS_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "revoked" });
  });
});

describe("not recognised", () => {
  it("is a recipient 401", async () => {
    const h = harness();
    h.override("/v1/recipient", h.err(401, "UNAUTHENTICATED"));
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "not-recognised" });
    expect(h.keys[0]?.freed).toBe(1);
  });

  it("is a QR row's token on a passphrase link: /recipient/key answers kind qr", async () => {
    const h = harness();
    h.session.start(PASS_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "not-recognised" });
  });

  it("is a passphrase row's token on a QR link: never unwrapped with K_invite, which is zeroed", async () => {
    const { invite, held } = heldInvite();
    const h = harness({ invite });
    h.album.kind = "passphrase";
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "not-recognised" });
    expect(h.invitesOpened).toEqual([]);
    expect(Array.from(held)).toEqual(new Array(32).fill(0));
  });

  it("is a 401 mid-grid", async () => {
    const h = harness();
    h.override(METADATA, h.err(401, "UNAUTHENTICATED"));
    await toGrid(h);
    expect(h.screen()).toEqual({ kind: "not-recognised" });
  });
});

describe("404 in the viewer is 'removed', and changes nothing else", () => {
  it("shows removed, keeps the key and the grid", async () => {
    const h = harness();
    await toGrid(h);
    h.override(`/v1/media/${media(2).id}/asset`, h.err(404, "NOT_FOUND"));
    h.session.openViewer(1);
    await settle();
    const s = albumScreen(h);
    expect(s.viewer?.phase).toBe("removed");
    expect(h.keys[0]?.freed).toBe(0);
    expect(s.items.every((i) => i.thumb.kind === "ready")).toBe(true);
  });
});

describe("a network failure is an offline state that changes no key state", () => {
  it("waits, frees nothing, closes nothing, and resumes on retry", async () => {
    const h = harness();
    await toGrid(h);
    h.override(`/v1/media/${media(1).id}/asset`, "network");
    h.session.openViewer(0);
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(albumScreen(h).viewer?.phase).toBe("loading");
    expect(h.keys[0]?.freed).toBe(0);
    expect(h.pictures.every((p) => p.closed === 0)).toBe(true);

    h.session.retryOffline();
    await settle();
    expect(h.session.current.offline).toBe(false);
    expect(albumScreen(h).viewer?.phase).toBe("shown");
    expect(assetsOf(h.sent)).toHaveLength(2);
  });

  it("before the first answer, and then carries on", async () => {
    const h = harness();
    h.override("/v1/recipient", "network", "network");
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(h.screen().kind).toBe("starting");
    h.session.retryOffline();
    await settle();
    h.session.retryOffline();
    await settle();
    expect(h.screen().kind).toBe("onboarding");
    expect(h.keys[0]?.freed).toBe(0);
  });
});

describe("429 waits for Retry-After", () => {
  it("sleeps for the interval, then retries", async () => {
    const h = harness();
    h.override(METADATA, h.err(429, "RATE_LIMITED", { "Retry-After": "7" }));
    await toGrid(h);
    expect(h.sleeps).toEqual([7000]);
    expect(paths(h.sent).filter((p) => p === METADATA)).toHaveLength(2);
    expect(albumScreen(h).phase).toBe("ready");
  });
});

// ── Damaged links and versions ────────────────────────────────────────────

describe("the dead page and the newer-version screen", () => {
  it("missing or malformed → dead, with no request", async () => {
    for (const f of ["", "#", "#v=1&a=nope"]) {
      const h = harness();
      h.session.start(f);
      await settle();
      expect(h.screen()).toEqual({ kind: "dead" });
      expect(h.sent).toEqual([]);
    }
  });

  it("unsupported version → open.newer-version, with no request", async () => {
    const h = harness();
    h.session.start("#v=2&x=y");
    await settle();
    expect(h.screen()).toEqual({ kind: "newer-version" });
    expect(h.sent).toEqual([]);
  });

  it("a label that will not open after a successful unwrap is corrupted data: the dead page", async () => {
    const h = harness();
    h.override("/v1/recipient", { status: 200, json: { id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", album_id: ALBUM_ID, label: "AAAA", kind: "qr", created_at: "x" } });
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "dead" });
  });

  it("a title that will not open is a damaged link (flows §4.4)", async () => {
    const h = harness();
    h.album.title = "";
    h.override(`/v1/albums/${ALBUM_ID}`, { status: 200, json: { id: ALBUM_ID, title: "AAAA", created_at: "x", media: [] } });
    await toGrid(h);
    expect(h.screen()).toEqual({ kind: "dead" });
  });

  it("a token for another album than the link's is a damaged link", async () => {
    const h = harness();
    h.album.albumIdInRow = "11111111-2222-4333-8444-555555555555";
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "dead" });
  });
});

// ── Passphrase entry and the derivation wait (flows §2, §4.2) ─────────────

describe("passphrase entry", () => {
  const start = async (unwrap?: UnwrapError) => {
    const h = harness(unwrap === undefined ? {} : { unwrap });
    h.album.kind = "passphrase";
    h.session.start(PASS_FRAGMENT);
    await settle();
    expect(h.screen()).toEqual({ kind: "passphrase", phase: "ready" });
    return h;
  };

  it("paints the wait before deriving, then opens onboarding", async () => {
    const h = await start();
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    expect(h.screen()).toEqual({ kind: "passphrase", phase: "deriving" });
    await settle();
    expect(h.framesAwaited()).toBe(1);
    expect(h.screen().kind).toBe("onboarding");
  });

  it("refuses a second submit while deriving", async () => {
    const h = await start();
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    await settle();
    expect(h.opened).toHaveLength(1);
  });

  it("empty never derives", async () => {
    const h = await start();
    h.session.submitPassphrase([]);
    h.session.submitPassphrase(["   "]);
    await settle();
    expect(h.screen()).toEqual({ kind: "passphrase", phase: "empty" });
    expect(h.opened).toEqual([]);
  });

  it("maps the crate's empty to pass.empty", async () => {
    const h = await start("empty");
    h.session.submitPassphrase(["\u0085"]);
    await settle();
    expect(h.screen()).toEqual({ kind: "passphrase", phase: "empty" });
  });

  it("a wrong passphrase stays on the screen and touches nothing", async () => {
    const h = await start("wrong-passphrase");
    const before = h.sent.length;
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    await settle();
    expect(h.screen()).toEqual({ kind: "passphrase", phase: "wrong" });
    expect(h.sent.length).toBe(before);
  });

  it("could-not-derive is the device screen, never a wrong passphrase", async () => {
    const h = await start("could-not-derive");
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    await settle();
    expect(h.screen()).toEqual({ kind: "device-failed" });
  });

  it("unusable material is not recognised", async () => {
    const h = await start("unusable-material");
    h.session.submitPassphrase(PASSPHRASE_WORDS);
    await settle();
    expect(h.screen()).toEqual({ kind: "not-recognised" });
  });
});

// ── WASM traps are terminal (the owner's amendment) ───────────────────────

describe("a trap poisons the tab", () => {
  it("in decryptAsset: device screen, nothing touches the instance again, no free()", async () => {
    const h = harness();
    await toGrid(h);
    h.env.trapOn.add("decryptAsset");
    h.session.openViewer(0);
    await settle();
    expect(h.screen()).toEqual({ kind: "device-failed" });
    expect(h.env.poison.poisoned).toBe(true);
    expect(h.keys[0]?.freed).toBe(0);
    expect(h.pictures.every((p) => p.closed === 1)).toBe(true);
    const calls = h.env.calls.length;
    expect(() => h.env.envelope.decryptThumb(h.keys[0] as never, new Uint8Array(16), new Uint8Array(1))).toThrow(EnvelopeUnavailable);
    expect(h.env.calls.length).toBe(calls);
  });
});

// ── The watermark's input ─────────────────────────────────────────────────

describe("the watermark", () => {
  it("is the decrypted label and the date", async () => {
    const h = harness();
    await toGrid(h);
    expect(albumScreen(h).watermark).toBe("María · 6 Aug 2026");
  });
});

// ── A server error is not a lost key (settled point 8) ────────────────────

describe("a 5xx is retryable and changes no key state", () => {
  const faults: [string, Parameters<ReturnType<typeof harness>["override"]>[1]][] = [
    ["500 INTERNAL", { status: 500, json: { code: "INTERNAL", message: "x" } }],
    ["a proxy's 502 page", { status: 502, bytes: new TextEncoder().encode("<html>Bad Gateway</html>") }],
    ["503 with no body", { status: 503, bytes: new Uint8Array(0) }],
  ];

  for (const [what, reply] of faults) {
    it(`${what} on the first call: offline-style state, the AlbumKey alive, then carries on`, async () => {
      const h = harness();
      h.override("/v1/recipient", reply);
      h.session.start(QR_FRAGMENT);
      await settle();
      expect(h.session.current.offline).toBe(true);
      expect(h.screen().kind).toBe("starting");
      expect(h.keys[0]?.freed).toBe(0);
      h.session.retryOffline();
      await settle();
      expect(h.screen().kind).toBe("onboarding");
      expect(h.keys[0]?.freed).toBe(0);
    });
  }

  it("on the metadata call, mid-grid: the grid loads after retry and the key was never freed", async () => {
    const h = harness();
    h.override(METADATA, { status: 500, json: { code: "INTERNAL", message: "x" } });
    h.session.start(QR_FRAGMENT);
    await settle();
    h.session.enterGrid();
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(h.screen().kind).toBe("album");
    expect(h.keys[0]?.freed).toBe(0);
    h.session.retryOffline();
    await settle();
    expect(albumScreen(h).phase).toBe("ready");
    expect(h.keys[0]?.freed).toBe(0);
  });

  it("on the asset: the viewer waits, the grid's pictures stay open", async () => {
    const h = harness();
    await toGrid(h);
    h.override(`/v1/media/${media(1).id}/asset`, { status: 500, json: { code: "INTERNAL", message: "x" } });
    h.session.openViewer(0);
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(albumScreen(h).viewer?.phase).toBe("loading");
    expect(h.keys[0]?.freed).toBe(0);
    expect(h.pictures.every((p) => p.closed === 0)).toBe(true);
    h.session.retryOffline();
    await settle();
    expect(albumScreen(h).viewer?.phase).toBe("shown");
  });

  it("a 200 of the wrong shape is a server fault too, not a damaged link", async () => {
    const h = harness();
    h.override("/v1/recipient", { status: 200, json: { unexpected: true } });
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen().kind).toBe("starting");
    expect(h.session.current.offline).toBe(true);
    expect(h.keys[0]?.freed).toBe(0);
  });

  it("a malformed label encoding is the server's fault, retryable", async () => {
    const h = harness();
    h.override("/v1/recipient", { status: 200, json: { id: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", album_id: ALBUM_ID, label: "A", kind: "qr", created_at: "x" } });
    h.session.start(QR_FRAGMENT);
    await settle();
    expect(h.screen().kind).toBe("starting");
    expect(h.session.current.offline).toBe(true);
    expect(h.keys[0]?.freed).toBe(0);
    h.session.retryOffline();
    await settle();
    expect(h.screen().kind).toBe("onboarding");
  });
});

// ── Metadata: width and height required, the rest ignored ────────────────

describe("metadata", () => {
  it("ignores unknown and optional fields", async () => {
    const h = harness();
    h.album.meta.set(media(1).id, JSON.stringify({ width: 1200, height: 1600, name: "IMG_1.jpg", taken_at: "2026-07-01T10:00:00Z", duration: 12.5, future: { nested: true } }));
    await toGrid(h);
    const item = albumScreen(h).items[0];
    expect(item?.size).toEqual({ w: 1200, h: 1600 });
    expect(item?.thumb.kind).toBe("ready");
  });

  const bad: [string, string][] = [
    ["width missing", JSON.stringify({ height: 1200 })],
    ["height missing", JSON.stringify({ width: 1600 })],
    ["a fractional width", JSON.stringify({ width: 1600.5, height: 1200 })],
    ["a zero height", JSON.stringify({ width: 1600, height: 0 })],
    ["a negative width", JSON.stringify({ width: -1, height: 1200 })],
    ["a width as a string", JSON.stringify({ width: "1600", height: 1200 })],
    ["not an object", JSON.stringify([1600, 1200])],
    ["not JSON", "width=1600"],
  ];
  for (const [what, json] of bad) {
    it(`${what}: that one cell fails, nothing is fetched for it, the album stands`, async () => {
      const h = harness();
      h.album.meta.set(media(2).id, json);
      await toGrid(h);
      const s = albumScreen(h);
      expect(s.phase).toBe("ready");
      expect(s.items.map((i) => i.thumb.kind)).toEqual(["ready", "unavailable", "ready"]);
      expect(paths(h.sent)).not.toContain(`/v1/media/${media(2).id}/thumbnail`);
      h.session.openViewer(1);
      h.session.retryThumb(media(2).id);
      await settle();
      expect(assetsOf(h.sent)).toEqual([]);
      expect(albumScreen(h).viewer).toBeNull();
    });
  }

  it("a caption is read from the envelope, exactly as written; a missing one is none", async () => {
    const h = harness();
    const caption = "Bañera con la abuela 🛁\nsegunda línea";
    h.album.meta.set(media(1).id, JSON.stringify({ width: 1200, height: 1600, caption, future: 1 }));
    await toGrid(h);
    const [first, second] = albumScreen(h).items;
    expect(first?.caption).toBe(caption);
    expect(second?.caption, "the harness's default document has no caption").toBeNull();
  });

  const noCaption: [string, unknown][] = [
    ["a number", 280],
    ["null", null],
    ["an object", { text: "hi" }],
    ["only whitespace", "  \n\t "],
  ];
  for (const [what, caption] of noCaption) {
    it(`a caption that is ${what} is no caption, and the photo still opens`, async () => {
      const h = harness();
      h.album.meta.set(media(1).id, JSON.stringify({ width: 1200, height: 1600, caption }));
      await toGrid(h);
      const item = albumScreen(h).items[0];
      expect(item?.caption).toBeNull();
      expect(item?.thumb.kind).toBe("ready");
    });
  }

  it("a caption longer than the client bound is still shown: the format sets no maximum (encryption spec §7)", async () => {
    const h = harness();
    const caption = "x".repeat(600);
    h.album.meta.set(media(1).id, JSON.stringify({ width: 1200, height: 1600, caption }));
    await toGrid(h);
    expect(albumScreen(h).items[0]?.caption).toBe(caption);
  });

  it("a metadata envelope that will not open fails its cell only", async () => {
    const h = harness();
    h.override(METADATA, {
      status: 200,
      json: { metadata: [media(1), media(2), media(3)].map((m, i) => ({ media_id: m.id, envelope: i === 0 ? "AAAA" : encodeBase64url(seal(JSON.stringify({ width: 4, height: 3 }))) })) },
    });
    await toGrid(h);
    expect(albumScreen(h).items.map((i) => i.thumb.kind)).toEqual(["unavailable", "ready", "ready"]);
  });
});
