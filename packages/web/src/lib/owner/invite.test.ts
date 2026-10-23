/*
 * Create invite (flows §3.8) through the whole owner session: the real API
 * client, a fake relay that keeps what it is sent, a fake envelope, and fakes
 * of the owner's two invite functions that hand out distinct, recognisable
 * ids, tokens, hashes and keys. Nothing here generates a secret: the fakes'
 * values are fixed bytes, so a test can search for every one of them.
 */
import { decodeBase64url, decodeBase64urlRange, encodeBase64url, RECIPIENT_KDF_V1 } from "@vitrina/shared";
import { describe, expect, it } from "vitest";
import { uuidToBytes } from "$lib/ids";
import { parseInvite } from "$lib/invite/parse";
import type { InviteScreen } from "./invite";
import { ALBUM_A, APP_ORIGIN, PASSWORD, RECIPIENT_IDS, STORED, harness, routes, settle, type Sent } from "./harness.test-support";

type H = ReturnType<typeof harness>;
const RECIPIENTS = `POST /v1/albums/${ALBUM_A}/recipients`;

async function inInvite(h: H): Promise<InviteScreen> {
  h.session.start();
  await settle();
  h.session.submitUnlock(PASSWORD);
  await settle();
  h.session.openAlbum(ALBUM_A);
  await settle();
  h.session.openInvite();
  await settle();
  return invite(h);
}

function invite(h: H): InviteScreen {
  const s = h.screen();
  if (s.kind !== "invite") throw new Error(`not on the invite screen: ${s.kind}`);
  return s;
}

const posts = (h: H): Sent[] => h.sent.filter((s) => s.method === "POST" && new URL(s.url).pathname === `/v1/albums/${ALBUM_A}/recipients`);
const body = (s: Sent | undefined) => JSON.parse(s?.body ?? "{}") as Record<string, unknown>;

/** The fake envelope's label blob: marker, the 16-byte id, the label. Reads it back under `id` or fails. */
function labelUnder(blob: unknown, id: string): string {
  const bytes = decodeBase64urlRange(blob as string, 41, 1024);
  const idBytes = uuidToBytes(id);
  if (bytes[0] !== 0xc7 || idBytes.some((b, i) => bytes[1 + i] !== b)) throw new Error("label not under this id");
  return new TextDecoder().decode(bytes.subarray(17)).replace(/\u0000+$/, "");
}

/** Every share screen any state ever held, with the index of the state that first held it. */
const shareStates = (h: H) => h.states.map((s, i) => [i, s.screen] as const).filter(([, s]) => s.kind === "invite" && s.share !== null);

describe("create invite, QR (flows §3.8)", () => {
  it("generates, encrypts the label, posts, and only then shows the share screen", async () => {
    const h = harness({ stored: STORED });
    const s = await inInvite(h);
    expect(s).toMatchObject({ step: "form", mode: "qr", share: null, languages: "idle" });

    const from = h.events.length;
    h.session.createInvite("  María  ");
    await settle();

    const order = h.events.slice(from).filter((e) => e === "createQrInvite" || e === `request ${RECIPIENTS}`);
    expect(order).toEqual(["createQrInvite", `request ${RECIPIENTS}`]);
    expect(h.env.calls.filter((c) => c === "encryptRecipientLabel")).toHaveLength(1);

    const [issued] = h.issued;
    const sent = body(posts(h)[0]);
    expect(sent).toEqual({
      id: RECIPIENT_IDS[0],
      kind: "qr",
      label: sent["label"],
      token_hash: encodeBase64url(issued?.tokenHash ?? new Uint8Array()),
      wrapped: encodeBase64url(new Uint8Array(48).fill(5)),
      wrap_nonce: encodeBase64url(new Uint8Array(24).fill(6)),
    });
    expect(labelUnder(sent["label"], RECIPIENT_IDS[0]), "the label is trimmed and sealed under this recipient's id").toBe("María");

    const done = invite(h);
    expect(done.step).toBe("share");
    expect(done.share?.kind).toBe("qr");
    expect(done.share?.label).toBe("María");
    const link = done.share?.link ?? "";
    expect(link.startsWith(`${APP_ORIGIN}/v/#`)).toBe(true);
    const parsed = parseInvite(new URL(link).hash);
    expect(parsed.ok && parsed.invite.mode === "qr" && parsed.invite.token).toBe(issued?.token);
    expect(parsed.ok && parsed.invite.mode === "qr" && encodeBase64url(parsed.invite.inviteKey)).toBe(issued?.inviteKey);
    expect(parsed.ok && parsed.invite.albumId).toEqual(uuidToBytes(ALBUM_A));
  });

  it("no state shows a share screen before the 201, even across a network loss and a 5xx", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.override(RECIPIENTS, "network", { status: 503, json: { code: "INTERNAL", message: "x" } });
    h.session.createInvite("María");
    await settle();
    expect(invite(h).step).toBe("creating");
    expect(h.session.current.offline).toBe(true);
    expect(shareStates(h)).toEqual([]);
    h.session.retryOffline();
    await settle();
    h.session.retryOffline();
    await settle();
    expect(invite(h).step).toBe("share");
    // The same create, resent: one id, one token, one wrap.
    const ids = posts(h).map((p) => body(p)["id"]);
    expect(ids).toEqual([RECIPIENT_IDS[0], RECIPIENT_IDS[0], RECIPIENT_IDS[0]]);
    expect(new Set(posts(h).map((p) => p.body)).size).toBe(1);
    expect(h.issued).toHaveLength(1);
  });

  it("a 409 regenerates everything: new id, new token, new key, new wrap, the label re-encrypted under the new id", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.override(RECIPIENTS, { status: 409, json: { code: "CONFLICT", message: "x" } });
    h.session.createInvite("María");
    await settle();

    expect(h.events.filter((e) => e === "createQrInvite")).toHaveLength(2);
    const [first, second] = posts(h).map(body);
    expect(first?.["id"]).toBe(RECIPIENT_IDS[0]);
    expect(second?.["id"]).toBe(RECIPIENT_IDS[1]);
    expect(second?.["token_hash"]).not.toBe(first?.["token_hash"]);
    expect(labelUnder(second?.["label"], RECIPIENT_IDS[1])).toBe("María");
    expect(() => labelUnder(second?.["label"], RECIPIENT_IDS[0]), "never the old id's label").toThrow();

    const link = invite(h).share?.link ?? "";
    const [old, fresh] = h.issued;
    expect(link).toContain(`t=${fresh?.token}`);
    expect(link).toContain(`k=${fresh?.inviteKey}`);
    expect(link).not.toContain(old?.token ?? "?");
    expect(link).not.toContain(old?.inviteKey ?? "?");
  });

  it("gives up after repeated 409s, shares nothing, and says so", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    const conflict = { status: 409, json: { code: "CONFLICT", message: "x" } } as const;
    h.override(RECIPIENTS, conflict, conflict, conflict);
    h.session.createInvite("María");
    await settle();
    expect(invite(h)).toMatchObject({ step: "form", problem: "failed", share: null });
    expect(new Set(posts(h).map((p) => body(p)["id"])).size).toBe(3);
  });

  it("a refusal (400) shares nothing; a 404 means the album is gone", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.override(RECIPIENTS, { status: 400, json: { code: "VALIDATION_FAILED", message: "x" } });
    h.session.createInvite("María");
    await settle();
    expect(invite(h)).toMatchObject({ step: "form", problem: "failed", share: null });

    h.override(RECIPIENTS, { status: 404, json: { code: "NOT_FOUND", message: "x" } });
    h.session.createInvite("María");
    await settle();
    expect(h.screen().kind).toBe("albums");
    expect(shareStates(h)).toEqual([]);
  });

  it("a key function that cannot finish is the device state, never a wrong input, and nothing is posted", async () => {
    const h = harness({ stored: STORED, invite: "could-not-derive" });
    await inInvite(h);
    h.session.createInvite("María");
    await settle();
    expect(invite(h)).toMatchObject({ step: "form", problem: "device" });
    expect(posts(h)).toEqual([]);
  });

  it("checks the label first: empty and over 60 code points call nothing", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.session.createInvite("   ");
    expect(invite(h).problem).toBe("label-empty");
    h.session.createInvite("😀".repeat(61));
    expect(invite(h).problem).toBe("label-too-long");
    h.session.createInvite("😀".repeat(60));
    await settle();
    expect(invite(h).step).toBe("share");
    expect(h.issued).toHaveLength(1);
  });

  it("never loads the wordlists in QR mode", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.session.createInvite("María");
    await settle();
    expect(h.wordlistLoads()).toBe(0);
  });
});

describe("create invite, passphrase (flows §3.8)", () => {
  it("loads the lists only when chosen, defaults to the display language, and offers every vetted one", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    expect(h.wordlistLoads()).toBe(0);
    h.session.chooseInviteMode("passphrase");
    expect(invite(h).languages).toBe("loading");
    await settle();
    expect(invite(h)).toMatchObject({ mode: "passphrase", languages: ["en", "es"], language: "en" });
    h.session.chooseInviteMode("qr");
    h.session.chooseInviteMode("passphrase");
    await settle();
    expect(h.wordlistLoads(), "once per screen").toBe(1);

    const es = harness({ stored: STORED, displayLanguage: "es" });
    await inInvite(es);
    es.session.chooseInviteMode("passphrase");
    await settle();
    expect(invite(es).language).toBe("es");

    const pt = harness({ stored: STORED, displayLanguage: "pt" });
    await inInvite(pt);
    pt.session.chooseInviteMode("passphrase");
    await settle();
    expect(invite(pt).language, "no Portuguese list: the first that exists, not a guess").toBe("en");
  });

  it("runs the derivation wait: the wait is shown and painted before the function runs, then the share screen", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.session.chooseInviteMode("passphrase");
    await settle();
    h.session.chooseInviteLanguage("es");
    const from = h.events.length;
    const fromState = h.states.length;
    h.session.createInvite("Tía Carmen");
    expect(invite(h).step).toBe("deriving");
    await settle();

    const ev = h.events.slice(from);
    expect(ev.indexOf("frames")).toBeLessThan(ev.indexOf("createPassphraseInvite es"));
    expect(ev.indexOf("createPassphraseInvite es")).toBeLessThan(ev.indexOf(`request ${RECIPIENTS}`));
    const steps = h.states.slice(fromState).map((s) => (s.screen.kind === "invite" ? s.screen.step : s.screen.kind));
    expect(steps[0]).toBe("deriving");
    expect(steps.at(-1)).toBe("share");
    expect(h.wordlistsSeen).toEqual(["es"]);

    const sent = body(posts(h)[0]);
    expect(sent).toMatchObject({
      id: RECIPIENT_IDS[0],
      kind: "passphrase",
      kdf_salt: encodeBase64url(new Uint8Array(16).fill(7)),
      kdf_memory_kib: RECIPIENT_KDF_V1.memoryKib,
      kdf_iterations: RECIPIENT_KDF_V1.iterations,
      kdf_parallelism: RECIPIENT_KDF_V1.parallelism,
    });
    const share = invite(h).share;
    expect(share?.kind).toBe("passphrase");
    if (share?.kind !== "passphrase") return;
    expect(share.words).toEqual(h.issued[0]?.words);
    expect(share.language).toBe("es");
    const parsed = parseInvite(new URL(share.link).hash);
    expect(parsed.ok && parsed.invite.mode).toBe("passphrase");
    expect(share.link).not.toContain("k=");
    // The words go nowhere but this screen: not as words, not joined, not encoded.
    const joined = new TextEncoder().encode(share.words.join(" "));
    const spellings = [...share.words, share.words.join(" "), encodeBase64url(joined), btoa(String.fromCharCode(...joined))];
    for (const s of h.sent) for (const w of spellings) expect(`${s.url} ${s.body} ${Object.values(s.headers).join(" ")}`).not.toContain(w);
  });

  it("a 409 redoes the wrap with a new id, and the derivation wait with it", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.session.chooseInviteMode("passphrase");
    await settle();
    h.override(RECIPIENTS, { status: 409, json: { code: "CONFLICT", message: "x" } });
    const from = h.events.length;
    h.session.createInvite("María");
    await settle();
    const ev = h.events.slice(from).filter((e) => e === "frames" || e.startsWith("createPassphraseInvite"));
    expect(ev).toEqual(["frames", "createPassphraseInvite en", "frames", "createPassphraseInvite en"]);
    expect(posts(h).map((p) => body(p)["id"])).toEqual([RECIPIENT_IDS[0], RECIPIENT_IDS[1]]);
    const share = invite(h).share;
    expect(share?.kind === "passphrase" && share.words).toEqual(h.issued[1]?.words);
  });

  it("no vetted list: passphrase mode says so, and create calls nothing", async () => {
    const h = harness({ stored: STORED, wordlists: [] });
    await inInvite(h);
    h.session.chooseInviteMode("passphrase");
    await settle();
    expect(invite(h).languages).toEqual([]);
    h.session.createInvite("María");
    expect(invite(h).problem).toBe("no-language");
    expect(h.issued).toEqual([]);
  });

  it("a list that will not load is retryable and changes nothing else", async () => {
    const h = harness({ stored: STORED, wordlists: "fail" });
    await inInvite(h);
    h.session.chooseInviteMode("passphrase");
    await settle();
    expect(invite(h).languages).toBe("failed");
    h.session.retryInviteLanguages();
    await settle();
    expect(h.wordlistLoads()).toBe(2);
  });

  it("a list the function refuses is a language problem, not the device", async () => {
    const h = harness({ stored: STORED, invite: "unusable-wordlist" });
    await inInvite(h);
    h.session.chooseInviteMode("passphrase");
    await settle();
    h.session.createInvite("María");
    await settle();
    expect(invite(h)).toMatchObject({ step: "form", problem: "no-language" });
  });
});

describe("the share screen is shown once (flows §3.8)", () => {
  async function shared(): Promise<H> {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.session.createInvite("María");
    await settle();
    expect(invite(h).step).toBe("share");
    return h;
  }

  it("leaving asks first; staying keeps it; confirming drops it and returns to the album", async () => {
    const h = await shared();
    const link = invite(h).share?.link ?? "";
    h.session.leaveInvite();
    expect(invite(h).leaving).toBe(true);
    h.session.askLeaveInvite(false);
    expect(invite(h)).toMatchObject({ leaving: false, step: "share" });
    expect(invite(h).share?.link).toBe(link);

    h.session.leaveInvite();
    h.session.leaveInvite(true);
    await settle();
    expect(h.screen().kind).toBe("album");
    // Nothing the session holds now mentions the invite.
    const held = JSON.stringify(h.session.current);
    const [issued] = h.issued;
    for (const secret of [link, issued?.token, issued?.inviteKey]) expect(held).not.toContain(secret);
  });

  it("nothing about the invite is ever written to storage", async () => {
    const h = await shared();
    h.session.leaveInvite();
    h.session.leaveInvite(true);
    await settle();
    expect(h.storage.writes.map(([k]) => k).every((k) => k.startsWith("vitrina:owner:"))).toBe(true);
    const stored = JSON.stringify([...h.storage.data]);
    const [issued] = h.issued;
    for (const secret of [issued?.token, issued?.inviteKey, "María"]) expect(stored).not.toContain(secret);
  });

  it("the token itself is never sent: only its hash", async () => {
    const h = await shared();
    const [issued] = h.issued;
    const token = issued?.token ?? "";
    const raw = decodeBase64url(token, 32);
    for (const s of h.sent) {
      const where = `${s.url} ${s.body} ${Object.values(s.headers).join(" ")}`;
      expect(where).not.toContain(token);
      expect(where).not.toContain(issued?.inviteKey ?? "?");
      expect(where).not.toContain(encodeBase64url(raw).slice(0, 20));
    }
  });

  it("cannot be left during the derivation wait or the create", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.override(RECIPIENTS, "network");
    h.session.createInvite("María");
    await settle();
    expect(invite(h).step).toBe("creating");
    h.session.leaveInvite(true);
    expect(h.screen().kind).toBe("invite");
  });

  it("the form can be left at once, with nothing created", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.session.leaveInvite();
    await settle();
    expect(h.screen().kind).toBe("album");
    expect(routes(h.sent)).not.toContain(RECIPIENTS);
  });

  it("a 401 while on the share screen ends the session, and the share view goes with it", async () => {
    const h = await shared();
    h.override(`GET /v1/albums/${ALBUM_A}`, { status: 401, json: { code: "UNAUTHENTICATED", message: "x" } });
    h.session.leaveInvite();
    h.session.leaveInvite(true);
    await settle();
    expect(h.screen().kind).toBe("signin");
    expect(JSON.stringify(h.session.current)).not.toContain(h.issued[0]?.token ?? "?");
  });
});

describe("an id given up on after a 409 is revoked once (the orphan follow-up)", () => {
  const revokes = (h: H) => h.sent.filter((s) => s.method === "POST" && /\/v1\/recipients\/[0-9a-f-]{36}\/revoke$/.test(new URL(s.url).pathname)).map((s) => new URL(s.url).pathname);

  it("a lost response had created the first row: after the new one is shared, the first is revoked and listed as revoked", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    // The relay already holds the first attempt's id, as a send whose response was lost would leave it.
    h.recipients.set(RECIPIENT_IDS[0], { id: RECIPIENT_IDS[0], album: ALBUM_A, body: {}, label: "x".repeat(60), revoked_at: null, album_opens: 0, media_opened: 0, last_opened_at: null });
    h.session.createInvite("María");
    await settle();
    expect(invite(h).step).toBe("share");
    expect(revokes(h)).toEqual([`/v1/recipients/${RECIPIENT_IDS[0]}/revoke`]);
    expect(h.recipients.get(RECIPIENT_IDS[0])?.revoked_at).not.toBeNull();
    expect(h.recipients.get(RECIPIENT_IDS[1])?.revoked_at, "never the one just shared").toBeNull();
    const order = h.events.filter((e) => e.includes("/recipients"));
    expect(order.indexOf(`request POST /v1/recipients/${RECIPIENT_IDS[0]}/revoke`)).toBeGreaterThan(order.lastIndexOf(`request ${RECIPIENTS}`));
  });

  it("a revoke that fails is not retried and changes nothing on screen (a 404, never created, is covered below)", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    h.override(RECIPIENTS, { status: 409, json: { code: "CONFLICT", message: "x" } });
    h.override(`POST /v1/recipients/${RECIPIENT_IDS[0]}/revoke`, "network");
    h.session.createInvite("María");
    await settle();
    expect(invite(h).step).toBe("share");
    expect(h.session.current.offline, "a best-effort revoke never shows the offline state").toBe(false);
    expect(revokes(h)).toEqual([`/v1/recipients/${RECIPIENT_IDS[0]}/revoke`]);
  });

  it("giving up after repeated 409s revokes every id tried; no 409, no revoke", async () => {
    const h = harness({ stored: STORED });
    await inInvite(h);
    const conflict = { status: 409, json: { code: "CONFLICT", message: "x" } } as const;
    h.override(RECIPIENTS, conflict, conflict, conflict);
    h.session.createInvite("María");
    await settle();
    expect(revokes(h)).toEqual(RECIPIENT_IDS.slice(0, 3).map((id) => `/v1/recipients/${id}/revoke`));

    const clean = harness({ stored: STORED });
    await inInvite(clean);
    clean.session.createInvite("María");
    await settle();
    expect(revokes(clean)).toEqual([]);
  });
});
