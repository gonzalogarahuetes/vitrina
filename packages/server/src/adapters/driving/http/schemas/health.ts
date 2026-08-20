/*
 * Per-route JSON Schema. vitrina-server-architecture.md §2 calls this directory the audit
 * surface, and brief §12 rests a real guarantee on it: Fastify's per-route
 * schema is what makes "no endpoint accepts key material" checkable "by a test
 * that walks the route table".
 *
 * That test only works if every route has an entry here, which is why the most
 * trivial route in the system gets one — the pattern has to be established
 * before there are routes where it matters.
 */

export const healthSchema = {
  response: {
    200: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["ok"] },
      },
      required: ["status"],
      additionalProperties: false,
    },
  },
} as const;
