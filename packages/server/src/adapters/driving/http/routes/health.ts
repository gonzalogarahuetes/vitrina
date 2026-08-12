import { type FastifyInstance } from "fastify";

export default async function health(fastify: FastifyInstance) {
  fastify.get("/health", async () => ({ status: "ok" }));
}
