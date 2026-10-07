import fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
} from "fastify";
import cors from "@fastify/cors";
import { stdSerializers } from "pino";
import type { UseCases } from "../../../application/use-cases/index.js";
import { errorEnvelope, notFoundEnvelope } from "./error-envelope.js";
import health from "./routes/health.js";
import { credentialRoutes } from "./routes/credentials.js";
import { albumRoutes } from "./routes/albums.js";
import { mediaRoutes } from "./routes/media.js";
import { recipientsRoutes } from "./routes/recipients.js";
import { ownRecipientRoutes } from "./routes/recipient.js";

/*
 * What the log may carry — the adapter's, never the caller's (see below).
 * `redact` is explicit so it survives someone widening the serialisers; it is
 * the second line of defence, since invite spec §2.1 keys live in the fragment.
 *
 * `errWithCause` buys STRUCTURE, not presence: pino's default flattens a cause
 * chain into `err.message` rather than dropping it (api-sketch §1.2, measured
 * 21 August 2026). The cost is that `err.message` is now the top level alone.
 */
const LOG_POLICY = {
  redact: ["req.headers.authorization", "req.headers.cookie"],
  serializers: { err: stdSerializers.errWithCause },
};

/**
 * The caller chooses where the log goes; this chooses what it may say — so the
 * spread puts LOG_POLICY last. A `??` here let every log-capturing test run
 * with no redaction, asserting its own configuration rather than production's.
 *
 * `NonNullable` is not cosmetic: admitting `undefined` sends `fastify()` down
 * its HTTP/2 overload under `exactOptionalPropertyTypes`.
 */
function loggerWithPolicy(
  override: BuildServerDeps["logger"],
): NonNullable<FastifyServerOptions["logger"]> {
  if (override === false) return false;

  const destination =
    override === undefined || override === true ? {} : override;
  return { ...destination, ...LOG_POLICY };
}

/** Not the whole `Config`: host and port belong to index.ts, which listens. */
export type HttpConfig = {
  readonly clientOrigin: string;
};

export type BuildServerDeps = {
  readonly config: HttpConfig;
  readonly useCases: UseCases;
  /**
   * Logger DESTINATION, not policy: `false` to silence, `{level, stream}` to
   * read lines back. LOG_POLICY is merged over it, so a test reads the same
   * shape production writes.
   */
  readonly logger?: FastifyServerOptions["logger"];
  /**
   * Extra plugins INSIDE the real `/v1` context; production passes nothing.
   * A route registered from outside is created after `setErrorHandler`, so it
   * inherits the envelope either way — and passes against the bug it tests.
   */
  readonly v1Plugins?: readonly FastifyPluginAsync[];
  /**
   * §9.7's upload deadline. Omit in production; a test sets it low so the
   * stalling-client case is a test rather than a two-minute wait.
   */
  readonly uploadDeadlineMs?: number;
};

/** §9.7, provisional: generous for 16 MiB, short enough not to be a leak. */
const UPLOAD_DEADLINE_MS = 120_000;

/*
 * Architecture §2: `{ config, useCases }`, because the CORS origin is
 * configuration rather than a use case. The three optional fields are test
 * seams production never passes. No repository reaches this function —
 * architecture §5 keeps them behind the use cases.
 */
export async function buildServer(
  deps: BuildServerDeps,
): Promise<FastifyInstance> {
  const app = fastify({
    logger: loggerWithPolicy(deps.logger),
    // bodyLimit stays at Fastify's 1 MiB default, which covers the JSON routes.
    // §9.7's uploads enforce their own: measured, `bodyLimit` reaches only the
    // parsers that accumulate a body, and theirs hands the stream through.
  });

  // Before any route: @fastify/cors installs an onRequest hook, and hooks only
  // apply to routes registered after them. The `await` does not do that.
  await app.register(cors, {
    origin: deps.config.clientOrigin, // exact string from config — never true, never "*"
    credentials: false, // Authorization header only; see note below
    // §9.9: `PUT` for §9.7's uploads, no `DELETE` because §4.2 means no route
    // deletes anything in v1.
    methods: ["GET", "POST", "PUT"],
    // Authorization is EXPLICIT, not wildcarded: the Fetch standard makes it a
    // non-wildcard header. So every authenticated request preflights, because
    // of bearer auth rather than Range (§3.1).
    allowedHeaders: ["Authorization", "Content-Type", "Range"],
    exposedHeaders: ["Content-Range", "Accept-Ranges", "Retry-After"],
    maxAge: 7200, // the maximum Chrome honours — NOT a claim about other browsers
  });
  /*
   * `credentials: false` is a decision (§3.2, brief §6 #6): bearer transport,
   * no cookies, so no SameSite=None or CSRF protection to get right.
   * `Content-Range`/`Accept-Ranges` are exposed for PR 5's ranged fetch and
   * `Retry-After` so a client can honour §7.6's backoff. `maxAge` is not a
   * promise — WebKit caps lower, and V.2 owns the real figure.
   */

  app.register(health); // unversioned, for uptime monitors — track-b-plan §3 B.6

  /*
   * BOTH MUST PRECEDE EVERY `await app.register(...)` BELOW — ordering, not
   * style. An awaited register loads immediately and its child snapshots the
   * parent's error handler, so a later `setErrorHandler` never reaches it and
   * a throwing `/v1` route returns Fastify's body (a silent #15 leak).
   * `setNotFoundHandler` is not order-sensitive; it stays here so the pair
   * cannot drift.
   */
  app.setErrorHandler(errorEnvelope);
  app.setNotFoundHandler(notFoundEnvelope);

  // The /v1 mount point, registered once.
  await app.register(
    async (v1) => {
      // One plugin each, so a `no-store` hook or a limiter stays encapsulated
      // to the routes that need it rather than everything under /v1.
      await v1.register(credentialRoutes({ useCases: deps.useCases }));
      // §9.2's create and list, §9.4's details, §9.5's metadata.
      await v1.register(albumRoutes({ useCases: deps.useCases }));
      // §9.6's create, §9.7's uploads, §9.8's status. No `no-store` hook —
      // see the note at the head of routes/media.ts.
      await v1.register(
        mediaRoutes({
          useCases: deps.useCases,
          uploadDeadlineMs: deps.uploadDeadlineMs ?? UPLOAD_DEADLINE_MS,
        }),
      );
      await v1.register(recipientsRoutes({ useCases: deps.useCases }));
      await v1.register(ownRecipientRoutes({ useCases: deps.useCases }));
      for (const plugin of deps.v1Plugins ?? []) {
        await v1.register(plugin);
      }
    },
    { prefix: "/v1" },
  );

  return app;
}
