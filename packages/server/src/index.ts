/*
 * Entry point. vitrina-server-architecture.md §2 gives this file one job, in this order:
 * read config → build adapters → build use cases → buildServer → listen.
 */

import { buildComposition } from "./composition-root.js";
import { loadConfig } from "./config.js";
import { buildServer } from "./adapters/driving/http/server.js";
import { createShutdown } from "./shutdown.js";

async function main(): Promise<void> {
  // First, so a missing CLIENT_ORIGIN or server secret fails before a socket
  // is opened — the secret absent or short is a hard failure, never a
  // generated substitute (api-sketch §8.2, brief §6 #17).
  const config = loadConfig();

  const { useCases, adapters } = buildComposition(config);

  const app = await buildServer({
    config: { clientOrigin: config.clientOrigin },
    useCases,
  });

  await app.listen({ host: config.host, port: config.port });

  const shutdown = createShutdown({
    app,
    pool: adapters.pool,
    log: (m) => app.log.info(m),
  });
  process.on("SIGTERM", (s) => void shutdown(s));
  process.on("SIGINT", (s) => void shutdown(s));
}

main().catch((error: unknown) => {
  // Nothing is listening yet and the logger may not exist, so this goes to
  // stderr directly. It is the one place a raw dump is correct: it is a boot
  // failure on the operator's own terminal, not a response to a client.
  console.error(error);
  process.exitCode = 1;
});
