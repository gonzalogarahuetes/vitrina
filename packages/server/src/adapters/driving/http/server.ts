import fastify, { type FastifyInstance } from "fastify";
import { errorEnvelope } from "./error-envelope.js";
import health from "./routes/health.js";

export function buildServer(): FastifyInstance {
  const app = fastify({
    logger: true,
    /* bodyLimit, etc. */
  });

  app.register(health); // unversioned, for uptime monitors
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
