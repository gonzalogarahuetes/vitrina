import { describe, expect, it } from "vitest";
import {
  ApiFailure,
  NetworkFailure,
  RefusedRequest,
  UnexpectedResponse,
  buildUrl,
  createApiClient,
  health,
} from "./client";

const ORIGIN = "https://api.vitrina.test";

type Sent = { url: string; init: RequestInit };

function recorder(respond: () => Response = () => Response.json({ status: "ok" })) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    sent.push({ url, init });
    return respond();
  }) as typeof fetch;
  return { sent, client: createApiClient(ORIGIN, fetchImpl) };
}

/*
 * Invite spec §2.1: no outbound request URL may carry key material. This is
 * its start — every refusal below happens before `fetch` is reached.
 */
describe("no outbound URL carries what it was not given", () => {
  const refused: [string, string, Record<string, string> | undefined][] = [
    ["a fragment in the path", "/v1/recipient#k=AAAA", undefined],
    ["an empty fragment", "/v1/recipient#", undefined],
    ["a query in the path", "/v1/recipient?k=AAAA", undefined],
    ["a ? standing where # belongs", "/v/?v=1&a=x&t=y&k=z", undefined],
    ["a protocol-relative path", "//evil.test/x", undefined],
    ["an absolute URL", "https://evil.test/x", undefined],
    ["a relative path", "v1/albums", undefined],
    ["a credential-shaped parameter", "/v1/albums", { key: "AAAA" }],
    ["the fragment's k, passed as a query", "/v1/albums", { k: "AAAA" }],
    ["the fragment's t, passed as a query", "/v1/albums", { t: "AAAA" }],
    ["token", "/v1/albums", { token: "AAAA" }],
    ["access_token, any case", "/v1/albums", { Access_Token: "AAAA" }],
  ];

  for (const [what, path, query] of refused) {
    it(`refuses ${what}, and sends nothing`, async () => {
      const { sent, client } = recorder();
      await expect(client.request({ method: "GET", path, ...(query ? { query } : {}) })).rejects.toBeInstanceOf(
        RefusedRequest,
      );
      expect(sent).toHaveLength(0);
    });
  }

  it("sends exactly the parameters it was given", async () => {
    const { sent, client } = recorder();
    await client.request({
      method: "GET",
      path: "/v1/albums/a1/access-log/entries",
      query: { recipient_id: "r1", limit: "100" },
    });
    expect(sent).toHaveLength(1);
    const url = new URL(sent[0]!.url);
    expect(url.origin).toBe(ORIGIN);
    expect(url.hash).toBe("");
    expect(sent[0]!.url).not.toContain("#");
    expect([...url.searchParams.keys()].sort()).toEqual(["limit", "recipient_id"]);
  });

  it("encodes a # inside a value rather than letting it become a fragment", () => {
    const url = buildUrl(ORIGIN, "/v1/x", { before: "1#k=AAAA" });
    expect(url.hash).toBe("");
    expect(url.href).not.toContain("#");
  });
});

describe("transport", () => {
  it("sends the token as a bearer header and never sends credentials", async () => {
    const { sent, client } = recorder();
    await client.request({ method: "GET", path: "/v1/albums", token: "tok" });
    const { init } = sent[0]!;
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer tok");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.redirect).toBe("error");
    expect(init.referrerPolicy).toBe("no-referrer");
    expect(sent[0]!.url).not.toContain("tok");
  });

  it("sends no Authorization header without a token", async () => {
    const { sent, client } = recorder();
    await health(client);
    expect(new Headers(sent[0]!.init.headers).has("Authorization")).toBe(false);
    expect(sent[0]!.url).toBe(`${ORIGIN}/health`);
  });
});

describe("errors are read by code, never by message", () => {
  it("maps the envelope to its code and drops the message", async () => {
    const { client } = recorder(() =>
      Response.json({ code: "ACCESS_REVOKED", message: "Wrong password" }, { status: 403 }),
    );
    const err = await client.request({ method: "GET", path: "/v1/recipient" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect((err as ApiFailure).code).toBe("ACCESS_REVOKED");
    expect((err as ApiFailure).status).toBe(403);
    expect(JSON.stringify(err)).not.toContain("Wrong password");
    expect((err as ApiFailure).message).not.toContain("Wrong password");
  });

  it("reads Retry-After on 429", async () => {
    const { client } = recorder(
      () =>
        new Response(JSON.stringify({ code: "RATE_LIMITED", message: "x" }), {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
    );
    const err = (await client.request({ method: "POST", path: "/v1/login" }).catch((e: unknown) => e)) as ApiFailure;
    expect(err.retryAfter).toBe(30);
  });

  it("treats an unknown code as an unexpected response, not a guess", async () => {
    const { client } = recorder(() => Response.json({ code: "WRONG_PASSWORD", message: "x" }, { status: 401 }));
    await expect(client.request({ method: "GET", path: "/v1/x" })).rejects.toBeInstanceOf(UnexpectedResponse);
  });

  it("treats a non-JSON error body (a proxy's 502 page) as unexpected", async () => {
    const { client } = recorder(() => new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(client.request({ method: "GET", path: "/v1/x" })).rejects.toBeInstanceOf(UnexpectedResponse);
  });

  it("reports no response as a network failure", async () => {
    const client = createApiClient(ORIGIN, (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch);
    await expect(health(client)).rejects.toBeInstanceOf(NetworkFailure);
  });

  it("rejects a 200 whose body is not the shape asked for", async () => {
    const { client } = recorder(() => Response.json({ status: "degraded" }));
    await expect(health(client)).rejects.toBeInstanceOf(UnexpectedResponse);
  });
});
