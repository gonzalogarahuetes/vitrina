type ShutdownDeps = {
  readonly app: { close(): Promise<void> };
  readonly pool: { end(): Promise<void> };
  readonly log: (message: string) => void;
  readonly timeoutMs?: number;
};

type ShutDown = (signal: string) => Promise<void>;

export function createShutdown(deps: ShutdownDeps): ShutDown {
  let shuttingDown = false;
  return async (signal: string) => {
    let failed = false;
    const timeoutMs = deps.timeoutMs ?? 15_000;

    if (shuttingDown) return;
    shuttingDown = true;

    const timer = setTimeout(() => {
      deps.log(`shutdown timed out after ${timeoutMs}ms`);
      process.exit(1);
    }, timeoutMs).unref();

    try {
      await deps.app.close();
    } catch (error) {
      deps.log(`Error in app shutdown with signal ${signal}: ${error}`);
      failed = true;
    } finally {
      try {
        await deps.pool.end();
      } catch (error) {
        deps.log(`Error in pool shutdown with signal ${signal}: ${error}`);
        failed = true;
      }

      clearTimeout(timer);
      process.exitCode = failed ? 1 : 0;
    }
  };
}
