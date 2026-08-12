import fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { errorEnvelope } from "./error-envelope.js";
import health from "./routes/health.js";
import { config } from "./config.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = fastify({
    logger: true,
    /* bodyLimit, etc. */
  });

  await app.register(cors, {
    origin: config.clientOrigin, // exact string from env — never true, never "*"
    credentials: false, // token auth, no cookies
    methods: ["GET", "POST", "DELETE"], // narrow to what the route table needs
    allowedHeaders: ["Authorization", "Content-Type", "Range"],
    exposedHeaders: ["Content-Range", "Accept-Ranges", "Retry-After"],
    maxAge: 7200, //Chrome caps preflight caching at exactly 7200s, so that's the maximum useful value
  });

  await app.register(health); // unversioned, for uptime monitors
  //   app.register(
  //     async (v1) => {
  // v1.register(ownerAuth,   { useCases })
  // v1.register(albums,      { useCases })
  // v1.register(media,       { useCases })
  // v1.register(recipients,  { useCases })
  // v1.register(delivery,    { useCases })
  // v1.register(accessLog,   { useCases })
  // },
  // { prefix: "/v1" },
  //   );

  app.setErrorHandler(errorEnvelope); // one shape, #15/#26
  return app;
}
