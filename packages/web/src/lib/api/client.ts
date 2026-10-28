/*
 * The one place this app makes an HTTP request. eslint.config.js forbids
 * `fetch` and every other network global outside this file.
 *
 * - Transport is `Authorization: Bearer`; cookies are never sent
 *   (brief §6 #6, api-sketch §7.2).
 * - Errors are read by `code` only, never by `message` (api-sketch §1.1).
 * - A request URL is built here from an origin, a path and an explicit query,
 *   and refused if it carries anything else: no fragment, no parameter nobody
 *   passed, nothing outside the API origin. Invite key material lives in a URL
 *   fragment (invite spec §2.1); this is where it would leak if it ever did.
 */
import type { ErrorCode } from "@vitrina/shared";

/*
 * Exhaustive over the shared union: a code added to @vitrina/shared without a
 * line here fails `svelte-check`, so the client can never meet a code it has
 * no branch for.
 */
const ERROR_CODES = {
  VALIDATION_FAILED: true,
  UNAUTHENTICATED: true,
  INVALID_CREDENTIALS: true,
  ACCESS_REVOKED: true,
  NOT_FOUND: true,
  CONFLICT: true,
  LENGTH_REQUIRED: true,
  PAYLOAD_TOO_LARGE: true,
  UNSUPPORTED_MEDIA_TYPE: true,
  RANGE_NOT_SATISFIABLE: true,
  RATE_LIMITED: true,
  INTERNAL: true,
  SIGNUP_NOT_ALLOWED: true,
} as const satisfies Record<ErrorCode, true>;

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(ERROR_CODES, value);
}

/** The API answered with its error envelope. `message` is deliberately not kept. */
export class ApiFailure extends Error {
  override readonly name = "ApiFailure";
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    /** Seconds, from `Retry-After`, when the server sent one (api-sketch §11.5). */
    readonly retryAfter: number | undefined,
  ) {
    super(code);
  }
}

/** No HTTP response at all. Flows §0: retry, and never change key state. */
export class NetworkFailure extends Error {
  override readonly name = "NetworkFailure";
}

/** A response that is not the API's: not its error envelope, or not the shape asked for. */
export class UnexpectedResponse extends Error {
  override readonly name = "UnexpectedResponse";
  constructor(readonly status: number) {
    super(`unexpected response (${status})`);
  }
}

/** The request was refused before it was sent. A programming error, never a user one. */
export class RefusedRequest extends Error {
  override readonly name = "RefusedRequest";
}

/*
 * Never accepted as a query parameter, even when passed explicitly — the
 * client side of api-sketch §7.2's rule, and the invite fragment's own keys.
 */
const CREDENTIAL_PARAMS = new Set(["token", "access_token", "key", "t", "k"]);

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export type ApiRequest = {
  readonly method: Method;
  /** Absolute path on the API origin: `/health`, `/v1/...`. No `?`, no `#`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly token?: string;
  readonly json?: unknown;
  readonly body?: Uint8Array<ArrayBuffer>;
  readonly range?: string;
};

export function buildUrl(
  origin: string,
  path: string,
  query: Readonly<Record<string, string>> = {},
): URL {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new RefusedRequest("path must be absolute on the API origin");
  }
  if (path.includes("#") || path.includes("?")) {
    throw new RefusedRequest(
      "path must not carry a fragment or a query; pass `query`",
    );
  }
  const url = new URL(path, origin);
  for (const [name, value] of Object.entries(query)) {
    if (CREDENTIAL_PARAMS.has(name.toLowerCase())) {
      throw new RefusedRequest(
        `query parameter "${name}" is credential-shaped`,
      );
    }
    url.searchParams.append(name, value);
  }

  // Checked on the URL as it will be sent, not on the inputs.
  const given = Object.keys(query).sort();
  const sent = [...url.searchParams.keys()].sort();
  if (
    url.origin !== origin ||
    url.hash !== "" ||
    url.href.includes("#") ||
    sent.length !== given.length ||
    sent.some((name, i) => name !== given[i])
  ) {
    throw new RefusedRequest("request URL differs from what was asked for");
  }
  return url;
}

export type ApiClient = {
  request(req: ApiRequest): Promise<Response>;
  json<T>(req: ApiRequest, accept: (body: unknown) => body is T): Promise<T>;
};

export function createApiClient(
  origin: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): ApiClient {
  async function request(req: ApiRequest): Promise<Response> {
    const url = buildUrl(origin, req.path, req.query);

    const headers = new Headers();
    if (req.token !== undefined)
      headers.set("Authorization", `Bearer ${req.token}`);
    if (req.range !== undefined) headers.set("Range", req.range);
    let body: BodyInit | undefined;
    if (req.json !== undefined) {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(req.json);
    } else if (req.body !== undefined) {
      headers.set("Content-Type", "application/octet-stream");
      body = req.body;
    }

    let res: Response;
    try {
      res = await fetchImpl(url.href, {
        method: req.method,
        headers,
        ...(body === undefined ? {} : { body }),
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new NetworkFailure("no response");
    }

    if (!res.ok) throw await toFailure(res);
    return res;
  }

  async function json<T>(
    req: ApiRequest,
    accept: (body: unknown) => body is T,
  ): Promise<T> {
    const res = await request(req);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new UnexpectedResponse(res.status);
    }
    if (!accept(body)) throw new UnexpectedResponse(res.status);
    return body;
  }

  return { request, json };
}

async function toFailure(res: Response): Promise<Error> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return new UnexpectedResponse(res.status);
  }
  const code =
    typeof body === "object" && body !== null
      ? (body as { code?: unknown }).code
      : undefined;
  if (!isErrorCode(code)) return new UnexpectedResponse(res.status);
  const retry = res.headers.get("Retry-After");
  const seconds =
    retry !== null && /^\d+$/.test(retry) ? Number(retry) : undefined;
  return new ApiFailure(code, res.status, seconds);
}

/** `GET /health` — unversioned, unauthenticated (api-sketch §2). */
export function health(client: ApiClient): Promise<{ status: "ok" }> {
  return client.json(
    { method: "GET", path: "/health" },
    (b): b is { status: "ok" } =>
      typeof b === "object" &&
      b !== null &&
      (b as { status?: unknown }).status === "ok",
  );
}
