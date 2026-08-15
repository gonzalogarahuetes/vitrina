import fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import type { UseCases } from "../../../application/use-cases/index.js";
import { errorEnvelope, notFoundEnvelope } from "./error-envelope.js";
import health from "./routes/health.js";

/**
 * What the HTTP adapter needs from configuration — deliberately not the whole
 * `Config`. Host and port belong to `index.ts`, which does the listening; an
 * adapter that cannot see them cannot come to depend on them.
 */
export type HttpConfig = {
  readonly clientOrigin: string;
};

export type BuildServerDeps = {
  readonly config: HttpConfig;
  readonly useCases: UseCases;
  /**
   * Logger override. Omit in production to get the redacted logger below; pass
   * `false` in tests so eight assertions do not emit eighty lines of pino JSON.
   */
  readonly logger?: FastifyServerOptions["logger"];
  /**
   * Extra plugins registered *inside* the real `/v1` context. Production passes
   * nothing; B.6's routes will replace the commented-out block below.
   *
   * This exists so a test can put a route in the same encapsulated context
   * B.6's routes will occupy, and that is not a convenience. A route registered
   * from outside `buildServer` is created after `setErrorHandler` has run, so it
   * inherits the envelope no matter what order this function uses internally —
   * a test written that way passes against the very bug it is meant to catch.
   * Verified both ways before this seam was added.
   */
  readonly v1Plugins?: readonly FastifyPluginAsync[];
};

/*
 * vitrina-server-architecture.md §2 records this signature as `buildServer(useCases)`. It also
 * needs the allowlisted CORS origin, which is configuration rather than a use
 * case, so deps is an object with both. Flagged rather than silently chosen —
 * §2's line wants updating to match.
 */
export async function buildServer(
  deps: BuildServerDeps,
): Promise<FastifyInstance> {
  const app = fastify({
    logger: deps.logger ?? {
      /*
       * CLAUDE.md's third hard rule puts logs in scope for key material.
       * Fastify's default serialiser logs method and URL only, so a token in an
       * Authorization header is not logged today — but that is an inherited
       * default, and this rule is one the project treats as catastrophic. Made
       * explicit so it survives someone widening the serialisers later.
       *
       * Note what this does *not* protect: invite spec §2.1 puts `token` and
       * `key` in the URL *fragment* precisely because fragments are never sent
       * to the server. Redaction is the second line of defence, not the first.
       */
      redact: ["req.headers.authorization", "req.headers.cookie"],
    },
    /*
     * bodyLimit stays at Fastify's 1 MiB default until B.6 settles the upload
     * path. Brief §10.1 proxies ciphertext through the API in v1, so whatever
     * that route accepts has to be sized against the 256 KiB chunk (encryption
     * spec §3.1) plus its 16-byte tag and envelope header — not guessed here.
     */
  });

  /*
   * CORS is registered before any route because @fastify/cors installs an
   * onRequest hook, and hooks only apply to routes registered after them. The
   * `await` does not provide that ordering — registration order does.
   */
  await app.register(cors, {
    origin: deps.config.clientOrigin, // exact string from config — never true, never "*"
    credentials: false, // Authorization header only; see note below
    methods: ["GET", "POST", "DELETE"], // narrow to what the route table needs
    allowedHeaders: ["Authorization", "Content-Type", "Range"],
    exposedHeaders: ["Content-Range", "Accept-Ranges"],
    maxAge: 7200, // Chrome caps preflight caching at 7200s — the maximum useful value
  });
  /*
   * `credentials: false` is a decision B.6 should record, not a default. Brief
   * §6 #6 allows that "a cookie may carry the token in the browser"; this says
   * it will not, and that the token travels in an Authorization header. That is
   * the better reading — it keeps the server stateless as #6 requires and
   * sidesteps CSRF entirely — but PR 2's auth mechanics inherit it, and flipping
   * it later means also dropping the wildcard-free origin (already the case) and
   * revisiting SameSite. `Range` is in allowedHeaders and `Content-Range` /
   * `Accept-Ranges` in exposedHeaders because without them the PR 4 chunk-fetch
   * route cannot work cross-origin at all: the browser would hide exactly the
   * headers the client needs to compute the next range (encryption spec §3.3).
   */

  app.register(health); // unversioned, for uptime monitors — track-b-plan §3 B.6

  /*
   * BOTH HANDLERS MUST PRECEDE EVERY `await app.register(...)` BELOW. This is
   * ordering, not style, and reordering it reintroduces a silent #15 leak.
   *
   * `await`ing a register forces that plugin to load immediately, and the child
   * context it creates snapshots the parent's error handler at creation time. A
   * root `setErrorHandler` called afterwards never reaches it, so a throwing
   * route inside `/v1` returns Fastify's own body.
   *
   * `setNotFoundHandler` is NOT
   * order-sensitive — Fastify applies it globally at ready time either way. Only
   * `setErrorHandler` is. They stay together anyway so the pair cannot drift.
   */
  app.setErrorHandler(errorEnvelope);
  app.setNotFoundHandler(notFoundEnvelope);

  // The /v1 mount point, registered once. B.6's routes drop in here.
  await app.register(
    async (v1) => {
      //   v1.register(ownerAuth,  { useCases: deps.useCases })
      //   v1.register(albums,     { useCases: deps.useCases })
      //   v1.register(media,      { useCases: deps.useCases })
      //   v1.register(recipients, { useCases: deps.useCases })
      //   v1.register(delivery,   { useCases: deps.useCases })
      //   v1.register(accessLog,  { useCases: deps.useCases })
      for (const plugin of deps.v1Plugins ?? []) {
        await v1.register(plugin);
      }
    },
    { prefix: "/v1" },
  );

  return app;
}
