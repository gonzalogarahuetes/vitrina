/*
 * The owner path in a real browser, with the production build, the real WASM,
 * the owner's real key functions, and a faked API (a relay in this file,
 * behind context.route). The relay stores whatever the app posts and hands it
 * back, so every wrapping that is opened here was made by the app itself.
 *
 *   1. One walk: sign up, reload into unlock (GET /v1/owner/key before any
 *      password field), a wrong password (no request), sign out, sign in from a
 *      fresh context (a private window), create an album, log out everywhere.
 *   2. Storage at each stop, judged by test/storage-allowlist.ts with
 *      `{ owner: true }`: sessionStorage may hold the token and its expiry,
 *      and the password, the proof and the email must appear nowhere.
 *   3. No CSP violation and no uncaught error on any owner page.
 *   4. Every request the app sent: the password in none, the proof only in
 *      the /signup and /login bodies, the email only in the three credential
 *      bodies, and nothing in a URL query or fragment.
 *   5. The blocklist chunk is requested only once signup is entered.
 *
 * The last tests break the checks on purpose and expect them to notice.
 */
import { expect, test, type BrowserContext, type Page, type Route } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { en } from "../../src/lib/copy/en.ts";
import { storageViolations } from "../storage-allowlist.ts";
import { apiOrigin, blocklistChunk, dumpStorage, watch } from "./helpers.ts";

/** As typed, spaces and capitals included: the app must send it unchanged. */
const EMAIL = "  Parent.Example@Example.COM ";
const PASSWORD = "copper kettle under the stairs 47";
const ARGON = 60_000;

type Logged = { method: string; path: string; search: string; hash: string; body: string; headers: Record<string, string> };

/** A relay that keeps what it is sent. Normalises the address as api-sketch §8.2 does. */
function fakeRelay(opts: { expiresInMs: number }) {
  const norm = (e: string) => e.normalize("NFC").trim().toLowerCase();
  const accounts = new Map<string, Record<string, unknown>>();
  const tokens = new Map<string, { email: string; revoked: boolean }>();
  const albums = new Map<string, Record<string, unknown>[]>();
  const log: Logged[] = [];
  let holdOwnerKey: Promise<void> | null = null;
  /** "METHOD /path" → Retry-After seconds, refused once with a 429. */
  const refuse = new Map<string, number>();

  const mint = (email: string) => {
    const token = randomBytes(32).toString("base64url");
    tokens.set(token, { email, revoked: false });
    return { token, expires_at: new Date(Date.now() + opts.expiresInMs).toISOString().replace(/\.\d+Z$/, "Z") };
  };

  async function handle(route: Route, pageOrigin: string): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const headers = await req.allHeaders();
    const cors = {
      "access-control-allow-origin": pageOrigin,
      "access-control-allow-headers": "authorization, content-type, range",
      "access-control-allow-methods": "GET, POST, PUT, DELETE",
      "access-control-expose-headers": "retry-after",
      "cache-control": "no-store",
    };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const body = req.postData() ?? "";
    log.push({ method: req.method(), path: url.pathname, search: url.search, hash: url.hash, body, headers });

    const json = (status: number, value: unknown) => route.fulfill({ status, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify(value) });
    const error = (status: number, code: string) => json(status, { code, message: "x" });
    const caller = () => {
      const t = /^Bearer (.+)$/.exec(headers["authorization"] ?? "")?.[1];
      const row = t === undefined ? undefined : tokens.get(t);
      return row === undefined || row.revoked ? null : { token: t as string, ...row };
    };
    const key = `${req.method()} ${url.pathname}`;
    const retryAfter = refuse.get(key);
    if (retryAfter !== undefined) {
      refuse.delete(key);
      return route.fulfill({
        status: 429,
        headers: { ...cors, "content-type": "application/json", "retry-after": String(retryAfter) },
        body: JSON.stringify({ code: "RATE_LIMITED", message: "x" }),
      });
    }

    if (key === "POST /v1/signup") {
      const b = JSON.parse(body) as Record<string, unknown>;
      const email = norm(b["email"] as string);
      if (accounts.has(email)) return error(409, "CONFLICT");
      accounts.set(email, b);
      albums.set(email, []);
      return json(201, { id: randomBytes(16).toString("hex"), created_at: new Date().toISOString(), ...mint(email) });
    }
    if (key === "POST /v1/login/params") {
      const a = accounts.get(norm((JSON.parse(body) as { email: string }).email));
      const decoy = { kdf_salt: randomBytes(16).toString("base64url"), kdf_memory_kib: 65536, kdf_iterations: 3, kdf_parallelism: 1 };
      return json(200, a === undefined ? decoy : { kdf_salt: a["kdf_salt"], kdf_memory_kib: a["kdf_memory_kib"], kdf_iterations: a["kdf_iterations"], kdf_parallelism: a["kdf_parallelism"] });
    }
    if (key === "POST /v1/login") {
      const b = JSON.parse(body) as { email: string; proof: string };
      const email = norm(b.email);
      const a = accounts.get(email);
      if (a === undefined || a["proof"] !== b.proof) return error(401, "INVALID_CREDENTIALS");
      return json(200, mint(email));
    }
    const who = caller();
    if (who === null) return error(401, "UNAUTHENTICATED");
    const a = accounts.get(who.email) as Record<string, unknown>;
    switch (key) {
      case "GET /v1/owner/key":
        if (holdOwnerKey !== null) await holdOwnerKey;
        return json(200, {
          kdf_salt: a["kdf_salt"],
          kdf_memory_kib: a["kdf_memory_kib"],
          kdf_iterations: a["kdf_iterations"],
          kdf_parallelism: a["kdf_parallelism"],
          wrapped_master: a["wrapped_master"],
          wrap_nonce: a["wrap_nonce"],
        });
      case "GET /v1/albums":
        return json(200, { albums: [...(albums.get(who.email) ?? [])].reverse() });
      case "POST /v1/albums": {
        const b = JSON.parse(body) as Record<string, unknown>;
        const list = albums.get(who.email) ?? [];
        if (list.some((x) => x["id"] === b["id"])) return error(409, "CONFLICT");
        const created_at = new Date().toISOString();
        list.push({ ...b, created_at, media_count: 0 });
        return json(201, { id: b["id"], created_at });
      }
      case "POST /v1/logout":
        (tokens.get(who.token) as { revoked: boolean }).revoked = true;
        return route.fulfill({ status: 204, headers: cors });
      case "POST /v1/logout/all":
        for (const t of tokens.values()) if (t.email === who.email) t.revoked = true;
        return route.fulfill({ status: 204, headers: cors });
    }
    return error(404, "NOT_FOUND");
  }

  return {
    log,
    tokens,
    accounts,
    /** The next request to `route` ("METHOD /path") gets a 429 with this Retry-After. */
    refuseNext(route: string, retryAfterSeconds: number): void {
      refuse.set(route, retryAfterSeconds);
    },
    /** Delays GET /v1/owner/key until the returned function is called. */
    hold(): () => void {
      let release!: () => void;
      holdOwnerKey = new Promise((r) => (release = r));
      return () => {
        holdOwnerKey = null;
        release();
      };
    },
    async attach(context: BrowserContext): Promise<void> {
      const base = test.info().project.use.baseURL as string;
      const origin = apiOrigin();
      await context.route((u) => u.origin === origin, (route) => handle(route, new URL(base).origin));
      // Anything else off-origin fails, as with no network.
      await context.route((u) => u.origin !== origin && u.origin !== new URL(base).origin, (route) => route.abort("internetdisconnected"));
    },
  };
}

const heading = (page: Page, name: string) => expect(page.getByRole("heading", { name, exact: true })).toBeVisible({ timeout: ARGON });

/** Every spelling of the owner's secrets that could end up stored. */
function secrets(proof: string): string[] {
  return [PASSWORD, encodeURIComponent(PASSWORD), proof, EMAIL, EMAIL.trim(), EMAIL.trim().toLowerCase(), encodeURIComponent(EMAIL.trim())];
}

async function assertStorage(page: Page, proof: string, owner: boolean): Promise<void> {
  const dump = await dumpStorage(page);
  expect(storageViolations(dump, secrets(proof), { owner }), "storage").toEqual([]);
  if (!owner) expect(Object.keys(dump.sessionStorage).filter((k) => k.startsWith("vitrina:"))).toEqual([]);
}

function assertRequests(log: readonly Logged[], proof: string): void {
  expect(log.length).toBeGreaterThan(0);
  for (const r of log) {
    const where = [r.path, r.search, r.hash, r.body, ...Object.values(r.headers)];
    expect(r.search, `${r.method} ${r.path} query`).toBe("");
    expect(r.hash, `${r.method} ${r.path} fragment`).toBe("");
    for (const w of where) expect(w, `password in ${r.method} ${r.path}`).not.toContain(PASSWORD);
    const credential = r.method === "POST" && ["/v1/signup", "/v1/login"].includes(r.path);
    if (!credential) for (const w of where) expect(w, `proof in ${r.method} ${r.path}`).not.toContain(proof);
    const withEmail = credential || (r.method === "POST" && r.path === "/v1/login/params");
    if (!withEmail) for (const w of where) expect(w.toLowerCase(), `email in ${r.method} ${r.path}`).not.toContain("parent.example");
    expect(r.headers["cookie"], "cookie").toBeUndefined();
  }
}

test("the owner walk: sign up, unlock, a wrong password, sign out, sign in elsewhere, create an album, log out everywhere", async ({ browser }) => {
  test.setTimeout(240_000);
  const relay = fakeRelay({ expiresInMs: 2 * 60 * 60 * 1000 }); // inside the 24 h warning window
  const chunk = blocklistChunk();

  // ── Device A: sign up ──────────────────────────────────────────────────
  const a = await browser.newContext();
  await relay.attach(a);
  const page = await a.newPage();
  const violationsA = await watch(page);
  const blocklistLoads: number[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith(chunk)) blocklistLoads.push(relay.log.length);
  });

  await page.goto("/");
  await heading(page, en["signin.title"]);
  expect(relay.log, "no request without a token").toEqual([]);
  expect(blocklistLoads, "blocklist before signup").toEqual([]);

  await page.getByRole("button", { name: en["signin.to-signup"] }).click();
  await heading(page, en["signup.title"]);
  await expect.poll(() => blocklistLoads.length, { message: "blocklist loaded on entering signup" }).toBe(1);
  await expect(page.getByText(en["signup.loss"])).toBeVisible();

  await page.getByLabel(en["signup.email.label"]).fill(EMAIL);
  await page.getByLabel(en["signup.password.label"]).fill("too short");
  await page.getByRole("button", { name: en["signup.submit"] }).click();
  await expect(page.getByText(en["signup.too-short"])).toBeVisible();
  expect(relay.log, "the policy is local").toEqual([]);

  await page.getByLabel(en["signup.password.label"]).fill(PASSWORD);
  await page.getByRole("button", { name: en["signup.submit"] }).click();
  await heading(page, en["albums.title"]);
  expect(relay.log.map((r) => `${r.method} ${r.path}`)).toEqual(["POST /v1/signup"]);
  const signup = JSON.parse(relay.log[0]?.body ?? "") as { email: string; proof: string };
  expect(signup.email, "the address exactly as typed").toBe(EMAIL);
  const proof = signup.proof;
  await expect(page.getByText(en["albums.empty"])).toBeVisible();
  await expect(page.getByText(/^Your session ends /)).toBeVisible();
  await assertStorage(page, proof, true);

  await page.getByRole("button", { name: en["album.create"] }).click();
  await page.getByLabel(en["album.title.label"]).fill("Verano 2026");
  await page.getByRole("button", { name: en["album.create.submit"] }).click();
  await expect(page.getByText("Verano 2026", { exact: true })).toBeVisible();
  const createBody = relay.log.at(-1)?.body ?? "";
  expect(createBody, "the title is ciphertext").not.toContain("Verano");

  // ── Reload into unlock: the wrapping is fetched before a password field exists ──
  const release = relay.hold();
  const before = relay.log.length;
  await page.reload();
  await expect(page.getByText(en["owner.checking"])).toBeVisible();
  await expect.poll(() => relay.log.length).toBe(before + 1);
  expect(relay.log.at(-1)?.path).toBe("/v1/owner/key");
  await expect(page.locator("input[type=password]"), "no password field before /owner/key answers").toHaveCount(0);
  release();
  await heading(page, en["unlock.prompt"]);
  await expect(page.locator("main")).not.toContainText("parent.example", { ignoreCase: true });

  // ── A wrong password: the tag fails locally, no request ─────────────────
  const atUnlock = relay.log.length;
  await page.getByLabel(en["unlock.password.label"], { exact: true }).fill("not the password at all");
  await page.getByRole("button", { name: en["unlock.submit"] }).click();
  await expect(page.getByText(en["unlock.wrong"])).toBeVisible({ timeout: ARGON });
  expect(relay.log.length, "a wrong password sends nothing").toBe(atUnlock);

  await page.getByLabel(en["unlock.password.label"], { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: en["unlock.submit"] }).click();
  await expect(page.getByText("Verano 2026", { exact: true })).toBeVisible({ timeout: ARGON });
  expect(relay.log.slice(atUnlock).map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/albums"]);
  expect(relay.log.some((r) => r.path === "/v1/login"), "unlock never logs in").toBe(false);
  await assertStorage(page, proof, true);

  // ── Sign out on this device ─────────────────────────────────────────────
  await page.getByRole("button", { name: en["logout.device"] }).click();
  await heading(page, en["signin.title"]);
  await expect(page.getByText(en["signed-out"])).toBeVisible();
  expect(relay.log.at(-1)?.path).toBe("/v1/logout");
  expect(relay.log.at(-1)?.headers["content-type"], "logout sends no Content-Type").toBeUndefined();
  await assertStorage(page, proof, false);
  expect(blocklistLoads, "the blocklist loaded once, for signup").toHaveLength(1);
  expect(await violationsA(), "CSP violations on device A").toEqual([]);

  // ── Device B, a fresh context (a private window): sign in ───────────────
  const b = await browser.newContext();
  await relay.attach(b);
  const pageB = await b.newPage();
  const violationsB = await watch(pageB);
  await pageB.goto("/");
  await heading(pageB, en["signin.title"]);
  const atSignin = relay.log.length;
  await pageB.getByLabel(en["signin.email.label"]).fill(EMAIL);
  await pageB.getByLabel(en["signin.password.label"], { exact: true }).fill(PASSWORD);
  await pageB.getByRole("button", { name: en["signin.submit"] }).click();
  await expect(pageB.getByText("Verano 2026", { exact: true })).toBeVisible({ timeout: ARGON });
  expect(relay.log.slice(atSignin).map((r) => `${r.method} ${r.path}`)).toEqual([
    "POST /v1/login/params",
    "POST /v1/login",
    "GET /v1/owner/key",
    "GET /v1/albums",
  ]);
  await assertStorage(pageB, proof, true);

  await pageB.getByRole("button", { name: en["album.create"] }).click();
  await pageB.getByLabel(en["album.title.label"]).fill("Otoño");
  await pageB.getByRole("button", { name: en["album.create.submit"] }).click();
  await expect(pageB.getByText("Otoño", { exact: true })).toBeVisible();

  // ── Log out everywhere ──────────────────────────────────────────────────
  await pageB.getByRole("button", { name: en["logout.everywhere"] }).click();
  await heading(pageB, en["signin.title"]);
  expect(relay.log.at(-1)?.path).toBe("/v1/logout/all");
  expect([...relay.tokens.values()].every((t) => t.revoked), "every session revoked").toBe(true);
  await assertStorage(pageB, proof, false);
  expect(await violationsB(), "CSP violations on device B").toEqual([]);

  assertRequests(relay.log, proof);
  await a.close();
  await b.close();
});

test("a stored token whose session has ended: sign-in says so, storage is cleared, and no unlock screen is shown", async ({ browser }) => {
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const ctx = await browser.newContext();
  await relay.attach(ctx);
  const page = await ctx.newPage();
  const violations = await watch(page);
  await page.addInitScript((token) => {
    if (sessionStorage.getItem("seeded") === null) {
      sessionStorage.setItem("vitrina:owner:token", token);
      sessionStorage.setItem("vitrina:owner:expires_at", "2026-10-29T12:00:00Z");
      sessionStorage.setItem("seeded", "1");
    }
  }, randomBytes(32).toString("base64url"));
  await page.goto("/");
  await heading(page, en["signin.title"]);
  await expect(page.getByText(en["session.ended"])).toBeVisible();
  expect(relay.log.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/owner/key"]);
  await expect(page.getByRole("heading", { name: en["unlock.prompt"], exact: true })).toHaveCount(0);
  const dump = await dumpStorage(page);
  expect(Object.keys(dump.sessionStorage).filter((k) => k.startsWith("vitrina:"))).toEqual([]);
  expect(await violations()).toEqual([]);
  await ctx.close();
});

// ── The checks, broken on purpose ─────────────────────────────────────────

test("the owner storage check notices the email written to sessionStorage", async ({ browser }) => {
  const relay = fakeRelay({ expiresInMs: 60_000 });
  const ctx = await browser.newContext();
  await relay.attach(ctx);
  const page = await ctx.newPage();
  await page.addInitScript((email) => sessionStorage.setItem("vitrina:owner:email", email), EMAIL);
  await page.goto("/");
  await heading(page, en["signin.title"]);
  const found = storageViolations(await dumpStorage(page), secrets("unused"), { owner: true });
  expect(found).toHaveLength(1);
  expect(found[0]).toMatch(/^sessionStorage .* holds secret /);
  expect(found.join(" ")).not.toContain(EMAIL.trim());
  await ctx.close();
});

test("the request audit notices a password in a request", () => {
  const log: Logged[] = [{ method: "GET", path: "/v1/albums", search: "", hash: "", body: "", headers: { "x-debug": PASSWORD } }];
  expect(() => assertRequests(log, "unused")).toThrow(/password in GET \/v1\/albums/);
  const leak: Logged[] = [{ method: "GET", path: "/v1/owner/key", search: "", hash: "", body: "", headers: { "x-proof": "PROOFVALUE" } }];
  expect(() => assertRequests(leak, "PROOFVALUE")).toThrow(/proof in GET \/v1\/owner\/key/);
});

// ── flows §0: a 429 on a credential route ─────────────────────────────────

test("a 429 on /login: back to the form with a countdown, the password field cleared, the address kept, nothing resent", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const ctx = await browser.newContext();
  await relay.attach(ctx);
  const page = await ctx.newPage();
  const violations = await watch(page);

  // An account to sign in to, made by the app itself.
  await page.goto("/");
  await page.getByRole("button", { name: en["signin.to-signup"] }).click();
  await page.getByLabel(en["signup.email.label"]).fill(EMAIL);
  await page.getByLabel(en["signup.password.label"]).fill(PASSWORD);
  await page.getByRole("button", { name: en["signup.submit"] }).click();
  await heading(page, en["albums.title"]);
  await page.getByRole("button", { name: en["logout.device"] }).click();
  await heading(page, en["signin.title"]);

  relay.refuseNext("POST /v1/login", 3);
  const email = page.getByLabel(en["signin.email.label"]);
  const password = page.getByLabel(en["signin.password.label"], { exact: true });
  const submit = page.getByRole("button", { name: en["signin.submit"] });
  await email.fill(EMAIL);
  await password.fill(PASSWORD);
  await submit.click();

  await expect(page.getByText(/^This network has to pause/)).toBeVisible({ timeout: ARGON });
  await expect(password, "the password field is cleared").toHaveValue("");
  await expect(email, "the address is kept, as typed").toHaveValue(EMAIL);
  await expect(submit, "submitting waits for the countdown").toBeDisabled();
  const logins = () => relay.log.filter((r) => r.path === "/v1/login").length;
  expect(logins()).toBe(1);

  // Retry-After is 3 s. Nothing is resent by the app in that time or after it.
  await page.waitForTimeout(4_000);
  expect(logins(), "no automatic resend").toBe(1);
  await expect(page.getByText(/^This network has to pause/)).toHaveCount(0);

  await password.fill(PASSWORD);
  await expect(submit).toBeEnabled();
  await submit.click();
  await heading(page, en["albums.title"]);
  expect(logins()).toBe(2);
  expect(await violations()).toEqual([]);
  await ctx.close();
});

test("a 429 on /signup: its own path, never signup.uncertain; the password field is cleared and the address kept", async ({ browser }) => {
  test.setTimeout(180_000);
  const relay = fakeRelay({ expiresInMs: 14 * 24 * 60 * 60 * 1000 });
  const ctx = await browser.newContext();
  await relay.attach(ctx);
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: en["signin.to-signup"] }).click();

  relay.refuseNext("POST /v1/signup", 2);
  const email = page.getByLabel(en["signup.email.label"]);
  const password = page.getByLabel(en["signup.password.label"]);
  await email.fill(EMAIL);
  await password.fill(PASSWORD);
  await page.getByRole("button", { name: en["signup.submit"] }).click();

  await expect(page.getByText(/^This network has to pause/)).toBeVisible({ timeout: ARGON });
  await expect(page.getByText(en["signup.uncertain"])).toHaveCount(0);
  await expect(password).toHaveValue("");
  await expect(email).toHaveValue(EMAIL);
  expect(relay.accounts.size, "no account created").toBe(0);

  await page.waitForTimeout(3_000);
  await password.fill(PASSWORD);
  await page.getByRole("button", { name: en["signup.submit"] }).click();
  await heading(page, en["albums.title"]);
  const bodies = relay.log.filter((r) => r.path === "/v1/signup").map((r) => JSON.parse(r.body) as { kdf_salt: string; wrapped_master: string });
  expect(bodies).toHaveLength(2);
  expect(bodies[1]?.kdf_salt, "a fresh salt on resubmit").not.toBe(bodies[0]?.kdf_salt);
  expect(bodies[1]?.wrapped_master, "a fresh K_master on resubmit").not.toBe(bodies[0]?.wrapped_master);
  await ctx.close();
});
