import { describe, expect, it } from "vitest";
import { EXPIRES_KEY, TOKEN_KEY } from "$lib/session/owner-session";
import {
  ALBUM_A,
  ALBUM_B,
  EMAIL,
  EXPIRES,
  NEW_ALBUM,
  NOW,
  PASSWORD,
  PROOF,
  PROOF_B64,
  STORED,
  TOKEN,
  TOKEN_2,
  albumRow,
  harness,
  routes,
  settle,
  type FakeHandle,
  type Sent,
} from "./harness.test-support";
import { EXPIRY_WARNING_MS } from "./session";

const zeroed = (b: Uint8Array) => b.every((x) => x === 0);
const live = (handles: readonly FakeHandle[]) => handles.filter((h) => h.freed === 0);

async function unlocked(h: ReturnType<typeof harness>) {
  h.session.start();
  await settle();
  h.session.submitUnlock(PASSWORD);
  await settle();
  expect(h.screen().kind).toBe("albums");
}

async function signedIn(h: ReturnType<typeof harness>) {
  h.session.start();
  h.session.submitSignin(EMAIL, PASSWORD);
  await settle();
  expect(h.screen().kind).toBe("albums");
}

async function signedUp(h: ReturnType<typeof harness>) {
  h.session.start();
  h.session.enterSignup();
  h.session.submitSignup(EMAIL, PASSWORD);
  await settle();
  expect(h.screen().kind).toBe("albums");
}

/** Every spelling of a secret that must never reach a request (or, for the proof, only its two bodies). */
function spellings(text: string): string[] {
  return [text, encodeURIComponent(text), JSON.stringify(text).slice(1, -1)];
}
const proofSpellings = () => {
  const hex = Array.from(PROOF, (b) => b.toString(16).padStart(2, "0")).join("");
  return [PROOF_B64, Buffer.from(PROOF).toString("base64"), hex, Array.from(PROOF).join(",")];
};

function assertNoSecrets(sent: readonly Sent[]) {
  expect(sent.length).toBeGreaterThan(0);
  for (const s of sent) {
    const url = new URL(s.url);
    const path = url.pathname;
    expect(url.hash, s.url).toBe("");
    expect(url.search, s.url).toBe("");
    const where = [s.url, s.body, ...Object.entries(s.headers).flat()];
    for (const w of where) {
      // The password never leaves the device, in any request (encryption spec §6.6).
      for (const p of spellings(PASSWORD)) expect(w, `password in ${path}`).not.toContain(p);
    }
    // The proof travels only in the /signup and /login bodies.
    if (!(s.method === "POST" && (path === "/v1/signup" || path === "/v1/login"))) {
      for (const p of proofSpellings()) for (const w of where) expect(w, `proof in ${path}`).not.toContain(p);
    }
    // The email travels only in the three credential bodies, never in a URL or header.
    if (!(s.method === "POST" && ["/v1/signup", "/v1/login/params", "/v1/login"].includes(path))) {
      expect(s.body, `email in ${path}`).not.toContain("Example");
    }
    expect(s.url).not.toContain("Example");
    // Bearer auth only, and never a cookie.
    expect(s.headers["cookie"]).toBeUndefined();
  }
}

/** Storage holds the token and its expiry and nothing else, ever. */
function assertStorage(h: ReturnType<typeof harness>) {
  for (const [k, v] of h.storage.writes) {
    expect([TOKEN_KEY, EXPIRES_KEY]).toContain(k);
    for (const p of [...spellings(PASSWORD), ...proofSpellings(), "Example", "xample"]) expect(v).not.toContain(p);
  }
  for (const k of h.storage.data.keys()) expect([TOKEN_KEY, EXPIRES_KEY]).toContain(k);
}

// ── Flows §3.1: page load ─────────────────────────────────────────────────

describe("page load (flows §3.1)", () => {
  it("no token: the sign-in screen, and no request at all", async () => {
    const h = harness();
    h.session.start();
    await settle();
    expect(h.screen()).toEqual({ kind: "signin", phase: "ready", notice: null, email: "", pausedUntil: null });
    expect(h.sent).toEqual([]);
  });

  it("a token: GET /v1/owner/key before the password is asked for", async () => {
    const h = harness({ stored: STORED });
    h.session.start();
    expect(h.screen().kind).toBe("checking");
    await settle();
    expect(routes(h.sent)).toEqual(["GET /v1/owner/key"]);
    expect(h.sent[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(h.screen()).toEqual({ kind: "unlock", phase: "ready", signingOut: false });
    // No unlock screen was shown before the answer.
    const first = h.states.findIndex((s) => s.screen.kind === "unlock");
    expect(h.states.slice(0, first).every((s) => s.screen.kind !== "unlock")).toBe(true);
  });

  it("a 401: storage cleared, sign-in, and the unlock screen is never shown", async () => {
    const h = harness({ stored: STORED });
    h.override("GET /v1/owner/key", h.err(401, "UNAUTHENTICATED"));
    h.session.start();
    await settle();
    expect(h.screen()).toEqual({ kind: "signin", phase: "ready", notice: "session-ended", email: "", pausedUntil: null });
    expect([...h.storage.data.keys()]).toEqual([]);
    expect(h.states.some((s) => s.screen.kind === "unlock")).toBe(false);
  });

  it("a network failure is offline: storage untouched, and retry continues to unlock", async () => {
    const h = harness({ stored: STORED });
    h.override("GET /v1/owner/key", "network");
    h.session.start();
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(h.storage.data.get(TOKEN_KEY)).toBe(TOKEN);
    h.session.retryOffline();
    await settle();
    expect(h.screen().kind).toBe("unlock");
    expect(h.session.current.offline).toBe(false);
  });

  it("a malformed stored token is cleared and treated as none", async () => {
    const h = harness({ stored: { [TOKEN_KEY]: "nope", [EXPIRES_KEY]: EXPIRES } });
    h.session.start();
    await settle();
    expect(h.screen().kind).toBe("signin");
    expect(h.sent).toEqual([]);
    expect([...h.storage.data.keys()]).toEqual([]);
  });
});

// ── Flows §3.1: unlock ────────────────────────────────────────────────────

describe("unlock (flows §3.1)", () => {
  it("never calls /login, so it never mints a session; a wrong password makes no request", async () => {
    const h = harness({ stored: STORED });
    h.session.start();
    await settle();
    h.session.submitUnlock("not the password at all");
    await settle();
    expect(h.screen()).toEqual({ kind: "unlock", phase: "wrong", signingOut: false });
    expect(routes(h.sent)).toEqual(["GET /v1/owner/key"]);
    h.session.submitUnlock("still wrong");
    await settle();
    h.session.submitUnlock(PASSWORD);
    await settle();
    expect(h.screen().kind).toBe("albums");
    expect(routes(h.sent)).toEqual(["GET /v1/owner/key", "GET /v1/albums"]);
    expect(routes(h.sent).some((r) => r.includes("/login"))).toBe(false);
  });

  it("applies no password policy: a short password unlocks if it is the account's", async () => {
    const h = harness({ stored: STORED, password: "short" });
    h.session.start();
    await settle();
    h.session.submitUnlock("short");
    await settle();
    expect(h.screen().kind).toBe("albums");
    expect(h.blocklistLoads()).toBe(0);
  });

  it("enters the derivation wait, waits two frames, and only then derives", async () => {
    const h = harness({ stored: STORED });
    h.session.start();
    await settle();
    h.session.submitUnlock(PASSWORD);
    expect(h.screen()).toEqual({ kind: "unlock", phase: "deriving", signingOut: false });
    await settle();
    expect(h.events.indexOf("frames")).toBeLessThan(h.events.indexOf("unlockMasterKey"));
    expect(h.framesAwaited()).toBe(1);
  });

  it("ignores a second submit while deriving", async () => {
    const h = harness({ stored: STORED });
    h.session.start();
    await settle();
    h.session.submitUnlock(PASSWORD);
    h.session.submitUnlock(PASSWORD);
    await settle();
    expect(h.events.filter((e) => e === "unlockMasterKey")).toHaveLength(1);
  });

  it("an empty password is its own state, with no derivation", async () => {
    const h = harness({ stored: STORED });
    h.session.start();
    await settle();
    h.session.submitUnlock("");
    expect(h.screen()).toEqual({ kind: "unlock", phase: "empty", signingOut: false });
    expect(h.events).not.toContain("unlockMasterKey");
  });

  it("could not derive is the device-failed screen, never a wrong password; the token is kept", async () => {
    const h = harness({ stored: STORED, unlock: "could-not-derive" });
    h.session.start();
    await settle();
    h.session.submitUnlock(PASSWORD);
    await settle();
    expect(h.screen().kind).toBe("device-failed");
    expect(h.storage.data.get(TOKEN_KEY)).toBe(TOKEN);
  });

  it("unusable material is a service problem, and retry fetches the wrapping again", async () => {
    const h = harness({ stored: STORED, unlock: "unusable-material" });
    h.session.start();
    await settle();
    h.session.submitUnlock(PASSWORD);
    await settle();
    expect(h.screen()).toEqual({ kind: "unlock", phase: "unavailable", signingOut: false });
    h.session.retryUnlock();
    await settle();
    expect(routes(h.sent)).toEqual(["GET /v1/owner/key", "GET /v1/owner/key"]);
    expect(h.screen()).toEqual({ kind: "unlock", phase: "ready", signingOut: false });
  });

  it("stores nothing", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    expect(h.storage.writes).toEqual([]);
    assertNoSecrets(h.sent);
  });
});

// ── Flows §3.4: the album list ────────────────────────────────────────────

describe("the album list (flows §3.4)", () => {
  it("opens every album key and decrypts every title", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    const s = h.screen();
    if (s.kind !== "albums") throw new Error();
    expect(s.albums).toEqual([
      { id: ALBUM_A, mediaCount: 12, title: "Verano 2026", failed: null },
      { id: ALBUM_B, mediaCount: 3, title: "Navidad", failed: null },
    ]);
    expect(live(h.handles).map((x) => `${x.kind} ${x.label}`)).toEqual(["master ", `album ${ALBUM_A}`, `album ${ALBUM_B}`]);
  });

  it("a wrapping that will not open, or a title that will not decrypt, is shown failed and not dropped", async () => {
    const h = harness({ stored: STORED, albumFails: new Map([[ALBUM_A, "cannot-open"]]) });
    h.albums.push({ ...albumRow("8b3e4cab-5d6f-4071-8cbd-2e3f4a5b6c7d", "x"), title: "A".repeat(60) });
    await unlocked(h);
    const s = h.screen();
    if (s.kind !== "albums") throw new Error();
    expect(s.albums.map((a) => [a.title, a.failed])).toEqual([
      [null, "key"],
      ["Navidad", null],
      [null, "title"],
    ]);
  });

  it("a 401 on GET /v1/albums frees the master key and clears storage", async () => {
    const h = harness({ stored: STORED });
    h.override("GET /v1/albums", h.err(401, "UNAUTHENTICATED"));
    h.session.start();
    await settle();
    h.session.submitUnlock(PASSWORD);
    await settle();
    expect(h.screen()).toMatchObject({ kind: "signin", notice: "session-ended" });
    expect(live(h.handles)).toEqual([]);
    expect([...h.storage.data.keys()]).toEqual([]);
  });
});

// ── Flows §3.3: sign-in ───────────────────────────────────────────────────

describe("sign-in on a new device (flows §3.3)", () => {
  it("runs api-sketch §8.4's steps in order and stores only the token and expiry", async () => {
    const h = harness();
    await signedIn(h);
    expect(routes(h.sent)).toEqual(["POST /v1/login/params", "POST /v1/login", "GET /v1/owner/key", "GET /v1/albums"]);
    expect(h.events.filter((e) => !e.startsWith("request") && !e.startsWith("openAlbumKey"))).toEqual(["frames", "deriveLoginCredential", "openMasterKey"]);
    expect(Object.fromEntries(h.storage.data)).toEqual({ [TOKEN_KEY]: TOKEN_2, [EXPIRES_KEY]: EXPIRES });
    assertStorage(h);
    assertNoSecrets(h.sent);
  });

  it("keeps the screen's prefill address for the whole attempt, so the form is never re-created mid-attempt", async () => {
    for (const prefill of ["", EMAIL]) {
      const h = harness({ password: "x" });
      h.override("POST /v1/login", h.err(401, "INVALID_CREDENTIALS"));
      h.session.start();
      if (prefill !== "") h.session.backToSignin(prefill);
      const from = h.states.length;
      h.session.submitSignin(EMAIL, PASSWORD);
      await settle();
      const during = h.states.slice(from).map((st) => st.screen);
      expect(during.length).toBeGreaterThan(1);
      for (const sc of during) expect(sc.kind === "signin" ? sc.email : "(left sign-in)", JSON.stringify(sc)).toBe(prefill);
    }
  });

  it("sends the address exactly as typed: not trimmed, not lowercased", async () => {
    const h = harness();
    await signedIn(h);
    for (const s of h.sent.filter((x) => x.url.includes("/login"))) expect((JSON.parse(s.body) as { email: string }).email).toBe(EMAIL);
  });

  it("zeroes the proof once /login answers, and the KEK is gone after /owner/key", async () => {
    const h = harness();
    await signedIn(h);
    expect(h.proofs).toHaveLength(1);
    expect(zeroed(h.proofs[0] as Uint8Array)).toBe(true);
    expect(h.handles.filter((x) => x.kind === "kek").map((x) => x.freed)).toEqual([1]);
  });

  it("401 INVALID_CREDENTIALS: signin.failed after the wait, proof zeroed, KEK freed, nothing stored", async () => {
    const h = harness();
    h.session.start();
    h.session.submitSignin(EMAIL, "the wrong password");
    await settle();
    expect(h.screen()).toEqual({ kind: "signin", phase: "failed", notice: null, email: "", pausedUntil: null });
    expect(zeroed(h.proofs[0] as Uint8Array)).toBe(true);
    expect(live(h.handles)).toEqual([]);
    expect(h.storage.writes).toEqual([]);
  });

  it("applies no password policy: a short password is derived and sent as a proof", async () => {
    const h = harness({ password: "short" });
    h.session.start();
    h.session.submitSignin(EMAIL, "short");
    await settle();
    expect(h.screen().kind).toBe("albums");
    expect(h.blocklistLoads()).toBe(0);
  });

  it("a password no account can have is signin.failed, with no /login request", async () => {
    const h = harness({ derive: "invalid-password" });
    h.session.start();
    h.session.submitSignin(EMAIL, "x\uD800y");
    await settle();
    expect(h.screen()).toMatchObject({ kind: "signin", phase: "failed" });
    expect(routes(h.sent)).toEqual(["POST /v1/login/params"]);
  });

  it("cannot-unlock after a successful login: revokes the new session, clears storage, never says wrong password", async () => {
    for (const error of ["cannot-unlock", "unusable-material"] as const) {
      const h = harness({ openMaster: error });
      h.session.start();
      h.session.submitSignin(EMAIL, PASSWORD);
      await settle();
      expect(h.screen()).toEqual({ kind: "cannot-unlock" });
      expect(routes(h.sent)).toEqual(["POST /v1/login/params", "POST /v1/login", "GET /v1/owner/key", "POST /v1/logout"]);
      expect(h.sent[3]?.headers["authorization"]).toBe(`Bearer ${TOKEN_2}`);
      expect([...h.storage.data.keys()]).toEqual([]);
      expect(live(h.handles)).toEqual([]);
      h.session.backToSignin();
      expect(h.screen()).toEqual({ kind: "signin", phase: "ready", notice: null, email: "", pausedUntil: null });
    }
  });

  it("a network loss at /login waits offline and resends the same proof; the proof is zeroed only when it settles", async () => {
    const h = harness();
    h.override("POST /v1/login", "network");
    h.session.start();
    h.session.submitSignin(EMAIL, PASSWORD);
    await settle();
    expect(h.session.current.offline).toBe(true);
    expect(zeroed(h.proofs[0] as Uint8Array)).toBe(false);
    h.session.retryOffline();
    await settle();
    const logins = h.sent.filter((s) => s.url.endsWith("/v1/login"));
    expect(logins.map((s) => (JSON.parse(s.body) as { proof: string }).proof)).toEqual([PROOF_B64, PROOF_B64]);
    expect(zeroed(h.proofs[0] as Uint8Array)).toBe(true);
    expect(h.screen().kind).toBe("albums");
  });

  // flows §0, the credential-route exception: back to the form, nothing held, nothing retried.
  for (const route of ["POST /v1/login/params", "POST /v1/login"] as const) {
    it(`a 429 on ${route} returns to the form with a countdown; nothing is held and nothing is retried`, async () => {
      const h = harness();
      h.override(route, h.err(429, "RATE_LIMITED", { "Retry-After": "37" }));
      h.session.start();
      h.session.submitSignin(EMAIL, PASSWORD);
      await settle();
      const until = NOW.getTime() + 37_000;
      expect(h.screen()).toEqual({ kind: "signin", phase: "paused", notice: null, email: "", pausedUntil: until });
      expect(h.sleeps, "no wait in place").toEqual([]);
      expect(routes(h.sent).filter((r) => r === route), "no automatic resend").toHaveLength(1);
      expect(live(h.handles), "every key handle freed").toEqual([]);
      for (const p of h.proofs) expect(zeroed(p), "the proof zeroed").toBe(true);
      expect(h.storage.writes).toEqual([]);
      expect(h.session.current.rateLimited).toBe(false);

      // Submitting is refused until the countdown ends.
      h.session.submitSignin(EMAIL, PASSWORD);
      await settle();
      expect(routes(h.sent).filter((r) => r === route)).toHaveLength(1);

      // At pausedUntil the form is ready again, and a resubmit derives afresh.
      const timer = h.timers.at(-1);
      expect(timer?.ms).toBe(37_000);
      h.setNow(new Date(until));
      timer?.fn();
      expect(h.screen()).toEqual({ kind: "signin", phase: "ready", notice: null, email: "", pausedUntil: null });
      const derivations = h.events.filter((e) => e === "deriveLoginCredential").length;
      h.session.submitSignin(EMAIL, PASSWORD);
      await settle();
      expect(h.screen().kind).toBe("albums");
      expect(h.events.filter((e) => e === "deriveLoginCredential"), "a fresh derivation").toHaveLength(derivations + 1);
    });
  }

  it("a timer that fires early reschedules instead of resuming", async () => {
    const h = harness();
    h.override("POST /v1/login/params", h.err(429, "RATE_LIMITED", { "Retry-After": "60" }));
    h.session.start();
    h.session.submitSignin(EMAIL, PASSWORD);
    await settle();
    h.setNow(new Date(NOW.getTime() + 30_000));
    h.timers.at(-1)?.fn();
    expect(h.screen()).toMatchObject({ phase: "paused" });
    expect(h.timers.at(-1)?.ms).toBe(30_000);
  });

  it("leaving the paused form cancels its countdown", async () => {
    const h = harness();
    h.override("POST /v1/login/params", h.err(429, "RATE_LIMITED", { "Retry-After": "60" }));
    h.session.start();
    h.session.submitSignin(EMAIL, PASSWORD);
    await settle();
    h.session.backToSignin(EMAIL);
    expect(h.timers.at(-1)?.cancelled).toBe(true);
  });

  it("a 429 on a token route is still waited out in place, then resent", async () => {
    const h = harness({ stored: STORED });
    h.override("GET /v1/albums", h.err(429, "RATE_LIMITED", { "Retry-After": "7" }));
    h.session.start();
    await settle();
    h.session.submitUnlock(PASSWORD);
    await settle();
    expect(h.sleeps).toEqual([7_000]);
    expect(routes(h.sent).filter((r) => r === "GET /v1/albums")).toHaveLength(2);
    expect(h.states.some((s) => s.rateLimited)).toBe(true);
    expect(h.session.current.rateLimited).toBe(false);
    expect(h.screen().kind).toBe("albums");
  });

  it("a 5xx or a 400 is signin.unavailable, not signin.failed", async () => {
    for (const [route, reply] of [
      ["POST /v1/login/params", { status: 503, json: { code: "INTERNAL", message: "x" } }],
      ["POST /v1/login", { status: 400, json: { code: "VALIDATION_FAILED", message: "x" } }],
    ] as const) {
      const h = harness();
      h.override(route, reply);
      h.session.start();
      h.session.submitSignin(EMAIL, PASSWORD);
      await settle();
      expect(h.screen()).toMatchObject({ kind: "signin", phase: "unavailable" });
      expect(live(h.handles)).toEqual([]);
    }
  });

  it("unusable parameters are signin.unavailable; could not derive is device-failed", async () => {
    const a = harness({ derive: "unusable-material" });
    a.session.start();
    a.session.submitSignin(EMAIL, PASSWORD);
    await settle();
    expect(a.screen()).toMatchObject({ kind: "signin", phase: "unavailable" });
    const b = harness({ derive: "could-not-derive" });
    b.session.start();
    b.session.submitSignin(EMAIL, PASSWORD);
    await settle();
    expect(b.screen().kind).toBe("device-failed");
  });

  it("does nothing with an empty address or password", async () => {
    const h = harness();
    h.session.start();
    h.session.submitSignin("   ", PASSWORD);
    h.session.submitSignin(EMAIL, "");
    await settle();
    expect(h.sent).toEqual([]);
  });
});

// ── Flows §3.2: signup ────────────────────────────────────────────────────

describe("signup (flows §3.2)", () => {
  it("creates the account with one derivation: no /login, no /owner/key, no /albums", async () => {
    const h = harness();
    await signedUp(h);
    expect(routes(h.sent)).toEqual(["POST /v1/signup"]);
    const body = JSON.parse(h.sent[0]?.body ?? "") as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["email", "kdf_iterations", "kdf_memory_kib", "kdf_parallelism", "kdf_salt", "proof", "wrap_nonce", "wrapped_master"]);
    expect(body["email"]).toBe(EMAIL);
    expect(body["proof"]).toBe(PROOF_B64);
    expect([body["kdf_memory_kib"], body["kdf_iterations"], body["kdf_parallelism"]]).toEqual([65536, 3, 1]);
    expect(h.screen()).toEqual({ kind: "albums", phase: "ready", albums: [], create: "closed", signingOut: null });
    expect(h.events.filter((e) => e === "createAccountKeys")).toHaveLength(1);
    expect(zeroed(h.proofs[0] as Uint8Array)).toBe(true);
    expect(live(h.handles).map((x) => x.kind)).toEqual(["master"]);
    expect(Object.fromEntries(h.storage.data)).toEqual({ [TOKEN_KEY]: TOKEN, [EXPIRES_KEY]: EXPIRES });
    assertStorage(h);
    assertNoSecrets(h.sent);
  });

  it("loads the blocklist only when signup is entered", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    expect(h.blocklistLoads()).toBe(0);
    const g = harness();
    g.session.start();
    g.session.submitSignin(EMAIL, PASSWORD);
    await settle();
    expect(g.blocklistLoads()).toBe(0);
    const s = harness();
    s.session.start();
    s.session.enterSignup();
    expect(s.blocklistLoads()).toBe(1);
  });

  it("enforces the policy before deriving: length in code points, the blocklist case-insensitively", async () => {
    const cases: [string, string][] = [
      ["eleven chars", "ready"],
      ["elevenchars", "too-short"],
      ["😀".repeat(11), "too-short"], // 22 UTF-16 units, 11 code points
      ["😀".repeat(12), "ready"],
      ["x".repeat(256), "ready"],
      ["x".repeat(257), "too-long"],
      ["PasswordPassword", "common"],
      ["x\uD800 twelve chars", "invalid"],
    ];
    for (const [pw, expected] of cases) {
      const h = harness({ password: pw });
      h.session.start();
      h.session.enterSignup();
      h.session.submitSignup(EMAIL, pw);
      await settle();
      const s = h.screen();
      if (expected === "ready") expect(s.kind, JSON.stringify(pw)).toBe("albums");
      else {
        expect(s, JSON.stringify(pw)).toEqual({ kind: "signup", phase: expected, pausedUntil: null });
        expect(h.events).not.toContain("createAccountKeys");
        expect(h.sent).toEqual([]);
      }
    }
  });

  it("409: signup.taken, the new K_master freed, the proof zeroed, nothing stored", async () => {
    const h = harness();
    h.override("POST /v1/signup", h.err(409, "CONFLICT"));
    h.session.start();
    h.session.enterSignup();
    h.session.submitSignup(EMAIL, PASSWORD);
    await settle();
    expect(h.screen()).toEqual({ kind: "signup", phase: "taken", pausedUntil: null });
    expect(live(h.handles)).toEqual([]);
    expect(zeroed(h.proofs[0] as Uint8Array)).toBe(true);
    expect(h.storage.writes).toEqual([]);
  });

  it("a lost response is signup.uncertain: one request, never a blind retry, and sign-in keeps the address", async () => {
    for (const reply of ["network", { status: 502, json: { code: "INTERNAL", message: "x" } }] as const) {
      const h = harness();
      h.override("POST /v1/signup", reply);
      h.session.start();
      h.session.enterSignup();
      h.session.submitSignup(EMAIL, PASSWORD);
      await settle();
      expect(h.screen()).toEqual({ kind: "signup-uncertain", email: EMAIL });
      expect(routes(h.sent)).toEqual(["POST /v1/signup"]);
      expect(h.session.current.offline).toBe(false);
      expect(live(h.handles)).toEqual([]);
      expect(zeroed(h.proofs[0] as Uint8Array)).toBe(true);
      h.session.backToSignin(EMAIL);
      expect(h.screen()).toEqual({ kind: "signin", phase: "ready", notice: null, email: EMAIL, pausedUntil: null });
    }
  });

  it("a 429 is its own path: no account was created, never signup.uncertain, and a resubmit starts afresh", async () => {
    const h = harness();
    h.override("POST /v1/signup", h.err(429, "RATE_LIMITED", { "Retry-After": "12" }));
    h.session.start();
    h.session.enterSignup();
    h.session.submitSignup(EMAIL, PASSWORD);
    await settle();
    const until = NOW.getTime() + 12_000;
    expect(h.screen()).toEqual({ kind: "signup", phase: "paused", pausedUntil: until });
    expect(h.states.some((s) => s.screen.kind === "signup-uncertain"), "never the lost-response path").toBe(false);
    expect(h.sleeps).toEqual([]);
    expect(routes(h.sent)).toEqual(["POST /v1/signup"]);
    expect(live(h.handles), "the new K_master freed").toEqual([]);
    expect(zeroed(h.proofs[0] as Uint8Array)).toBe(true);
    expect(h.storage.writes).toEqual([]);

    h.session.submitSignup(EMAIL, PASSWORD);
    await settle();
    expect(routes(h.sent), "refused while paused").toEqual(["POST /v1/signup"]);

    h.setNow(new Date(until));
    h.timers.at(-1)?.fn();
    expect(h.screen()).toEqual({ kind: "signup", phase: "ready", pausedUntil: null });
    h.session.submitSignup(EMAIL, PASSWORD);
    await settle();
    expect(h.screen().kind).toBe("albums");
    // A fresh derivation: a second createAccountKeys, a second K_master.
    expect(h.events.filter((e) => e === "createAccountKeys")).toHaveLength(2);
    expect(h.handles.filter((x) => x.kind === "master")).toHaveLength(2);
    expect(live(h.handles)).toHaveLength(1);
  });

  it("a lost signup response is still signup.uncertain, not paused", async () => {
    const h = harness();
    h.override("POST /v1/signup", "network");
    h.session.start();
    h.session.enterSignup();
    h.session.submitSignup(EMAIL, PASSWORD);
    await settle();
    expect(h.screen()).toEqual({ kind: "signup-uncertain", email: EMAIL });
  });

  it("400 is a generic failure", async () => {
    const h = harness();
    h.override("POST /v1/signup", h.err(400, "VALIDATION_FAILED"));
    h.session.start();
    h.session.enterSignup();
    h.session.submitSignup(EMAIL, PASSWORD);
    await settle();
    expect(h.screen()).toEqual({ kind: "signup", phase: "failed", pausedUntil: null });
  });

  it("could not derive is device-failed; an empty or invalid password from the crate is signup.invalid", async () => {
    const a = harness({ createAccount: "could-not-derive" });
    a.session.start();
    a.session.enterSignup();
    a.session.submitSignup(EMAIL, PASSWORD);
    await settle();
    expect(a.screen().kind).toBe("device-failed");
    const b = harness({ createAccount: "invalid-password" });
    b.session.start();
    b.session.enterSignup();
    b.session.submitSignup(EMAIL, PASSWORD);
    await settle();
    expect(b.screen()).toEqual({ kind: "signup", phase: "invalid", pausedUntil: null });
  });
});

// ── Flows §3.5: create album ──────────────────────────────────────────────

describe("create album (flows §3.5)", () => {
  async function create(h: ReturnType<typeof harness>, title: string) {
    h.session.openCreate();
    h.session.createAlbum(title);
    await settle();
  }

  it("posts the client's id, the encrypted title and the wrapping, and lists the album first", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    await create(h, "  Cumpleaños  ");
    const post = h.sent.find((s) => s.method === "POST" && s.url.endsWith("/v1/albums"));
    const body = JSON.parse(post?.body ?? "") as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(["id", "title", "wrap_nonce", "wrapped_key"]);
    expect(body["id"]).toBe(NEW_ALBUM);
    expect(body["title"]).not.toContain("Cumplea");
    const s = h.screen();
    if (s.kind !== "albums") throw new Error();
    expect(s.create).toBe("closed");
    expect(s.albums[0]).toEqual({ id: NEW_ALBUM, mediaCount: 0, title: "Cumpleaños", failed: null });
    expect(live(h.handles).map((x) => x.label)).toContain(NEW_ALBUM);
    assertNoSecrets(h.sent);
  });

  it("409 means it was already created: success", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.override("POST /v1/albums", h.err(409, "CONFLICT"));
    await create(h, "Otoño");
    const s = h.screen();
    if (s.kind !== "albums") throw new Error();
    expect(s.albums[0]?.title).toBe("Otoño");
    expect(s.create).toBe("closed");
  });

  it("a network loss retries with the same id and body", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.override("POST /v1/albums", "network");
    await create(h, "Otoño");
    expect(h.session.current.offline).toBe(true);
    h.session.retryOffline();
    await settle();
    const posts = h.sent.filter((s) => s.method === "POST" && s.url.endsWith("/v1/albums"));
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toBe(posts[1]?.body);
    expect(h.events.filter((e) => e.startsWith("createAlbumKey"))).toHaveLength(1);
  });

  it("refuses an empty title and one over 200 code points, before any key is made", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    await create(h, "   ");
    expect(h.screen()).toMatchObject({ create: "empty" });
    h.session.createAlbum("😀".repeat(201));
    await settle();
    expect(h.screen()).toMatchObject({ create: "too-long" });
    h.session.createAlbum("😀".repeat(200));
    await settle();
    expect(h.screen()).toMatchObject({ create: "closed" });
    expect(h.events.filter((e) => e.startsWith("createAlbumKey"))).toHaveLength(1);
  });

  it("a refused create frees the new album key", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.override("POST /v1/albums", h.err(400, "VALIDATION_FAILED"));
    await create(h, "Otoño");
    expect(h.screen()).toMatchObject({ create: "failed" });
    expect(h.handles.find((x) => x.label === NEW_ALBUM)?.freed).toBe(1);
  });
});

// ── Flows §3.11: logout ───────────────────────────────────────────────────

describe("logout (flows §3.11)", () => {
  it("frees every handle, then calls the route, then clears storage", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    let liveAtRequest = -1;
    let storedAtRequest: string | undefined;
    const original = h.sent.push.bind(h.sent);
    h.sent.push = (...items: Sent[]) => {
      if (items[0]?.url.endsWith("/v1/logout")) {
        liveAtRequest = live(h.handles).length;
        storedAtRequest = h.storage.data.get(TOKEN_KEY);
      }
      return original(...items);
    };
    h.session.logout("device");
    await settle();
    expect(liveAtRequest).toBe(0);
    expect(storedAtRequest).toBe(TOKEN);
    expect([...h.storage.data.keys()]).toEqual([]);
    expect(h.screen()).toEqual({ kind: "signin", phase: "ready", notice: "signed-out", email: "", pausedUntil: null });
    const req = h.sent.at(-1);
    expect(req?.headers["content-type"]).toBeUndefined();
    expect(req?.body).toBe("");
  });

  it("everywhere uses /v1/logout/all", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.session.logout("everywhere");
    await settle();
    expect(routes(h.sent).at(-1)).toBe("POST /v1/logout/all");
  });

  it("if the call fails: the keys are gone, the token is kept for a retry, and leaving clears it", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.override("POST /v1/logout", "network");
    h.session.logout("device");
    await settle();
    expect(h.screen()).toEqual({ kind: "signed-out-partial", scope: "device", retrying: false });
    expect(live(h.handles)).toEqual([]);
    expect(h.storage.data.get(TOKEN_KEY)).toBe(TOKEN);
    h.session.logout("device");
    await settle();
    expect(h.screen()).toMatchObject({ kind: "signin", notice: "signed-out" });
    expect([...h.storage.data.keys()]).toEqual([]);

    const g = harness({ stored: STORED });
    await unlocked(g);
    g.override("POST /v1/logout/all", { status: 500, json: { code: "INTERNAL", message: "x" } });
    g.session.logout("everywhere");
    await settle();
    g.session.leaveAfterPartial();
    expect([...g.storage.data.keys()]).toEqual([]);
    expect(g.screen().kind).toBe("signin");
  });

  it("a 401 from logout means the session had already ended: signed out", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.override("POST /v1/logout", h.err(401, "UNAUTHENTICATED"));
    h.session.logout("device");
    await settle();
    expect(h.screen()).toMatchObject({ kind: "signin", notice: "signed-out" });
  });

  it("from unlock, after confirming: no key was ever opened, and storage is cleared", async () => {
    const h = harness({ stored: STORED });
    h.session.start();
    await settle();
    h.session.logout("device"); // not confirmed: ignored
    expect(routes(h.sent)).toEqual(["GET /v1/owner/key"]);
    h.session.askUnlockSignOut(true);
    h.session.logout("device");
    await settle();
    expect(routes(h.sent)).toEqual(["GET /v1/owner/key", "POST /v1/logout"]);
    expect([...h.storage.data.keys()]).toEqual([]);
    expect(h.events).not.toContain("unlockMasterKey");
  });

  it("dispose (leaving the page) frees every handle and keeps the stored token", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.session.dispose();
    expect(live(h.handles)).toEqual([]);
    expect(h.storage.data.get(TOKEN_KEY)).toBe(TOKEN);
  });
});

// ── Flows §1.1: any owner 401 ─────────────────────────────────────────────

describe("a 401 from any owner route", () => {
  it("while creating an album: every handle freed, storage cleared, the session-ended sign-in", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.override("POST /v1/albums", h.err(401, "UNAUTHENTICATED"));
    h.session.openCreate();
    h.session.createAlbum("Otoño");
    await settle();
    expect(h.screen()).toMatchObject({ kind: "signin", notice: "session-ended" });
    expect(live(h.handles)).toEqual([]);
    expect([...h.storage.data.keys()]).toEqual([]);
    expect(h.session.current.expiry).toBeNull();
  });

  it("from /owner/key during sign-in frees the KEK", async () => {
    const h = harness();
    h.override("GET /v1/owner/key", h.err(401, "UNAUTHENTICATED"));
    h.session.start();
    h.session.submitSignin(EMAIL, PASSWORD);
    await settle();
    expect(h.screen()).toMatchObject({ kind: "signin" });
    expect(live(h.handles)).toEqual([]);
    expect([...h.storage.data.keys()]).toEqual([]);
  });
});

// ── Flows §3.12: session expiry ───────────────────────────────────────────

describe("session expiry (flows §3.12)", () => {
  it("warns from the stored expires_at, on the device's clock", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    const endsAt = new Date(EXPIRES);
    expect(h.session.current.expiry).toEqual({ endsAt, ending: false });
    const timer = h.timers.at(-1);
    expect(timer?.ms).toBe(endsAt.getTime() - EXPIRY_WARNING_MS - NOW.getTime());
    h.setNow(new Date(endsAt.getTime() - EXPIRY_WARNING_MS + 1));
    timer?.fn();
    expect(h.session.current.expiry).toEqual({ endsAt, ending: true });
  });

  it("warns at once when already inside the window, and the 401 stays the authority", async () => {
    const h = harness({ stored: { ...STORED, "vitrina:owner:expires_at": "2026-10-15T13:00:00Z" } });
    await unlocked(h);
    expect(h.session.current.expiry?.ending).toBe(true);
    expect(h.screen().kind).toBe("albums");
  });

  it("logout cancels the timer", async () => {
    const h = harness({ stored: STORED });
    await unlocked(h);
    h.session.logout("device");
    await settle();
    expect(h.timers.every((t) => t.cancelled)).toBe(true);
  });
});

// ── A WASM trap ───────────────────────────────────────────────────────────

describe("a WASM trap", () => {
  it("is device-failed, and no handle is touched afterwards", async () => {
    const h = harness({ stored: STORED });
    h.env.trapOn.add("decryptAlbumTitle");
    h.session.start();
    await settle();
    h.session.submitUnlock(PASSWORD);
    await settle();
    expect(h.screen().kind).toBe("device-failed");
    expect(h.env.poison.poisoned).toBe(true);
    expect(h.handles.every((x) => x.freed === 0)).toBe(true);
    expect(h.storage.data.get(TOKEN_KEY)).toBe(TOKEN);
  });
});
