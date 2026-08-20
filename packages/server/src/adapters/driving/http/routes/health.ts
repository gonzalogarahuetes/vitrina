import type { FastifyInstance } from "fastify";
import { healthSchema } from "../schemas/health.js";

/*
 * The only Phase 0 route (phase-0-plan §10: "No server endpoints beyond a health
 * check"), and deliberately unversioned — track-b-plan §3 B.6 puts `/v1` on
 * every route "except /health", because an uptime monitor should not have to
 * follow an API version.
 *
 * It reports that the process is up and nothing more. It does not check
 * Postgres or object storage: a readiness check that fails when a dependency
 * blips gets a healthy process restarted, and B.6 has not specified one.
 */
export default async function health(app: FastifyInstance) {
  app.get("/health", { schema: healthSchema }, async () => ({
    status: "ok" as const,
  }));
}
