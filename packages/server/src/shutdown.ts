type ShutdownDeps = {
  readonly app: { close(): Promise<void> };
  readonly pool: { end(): Promise<void> };
  /** `S3Client.destroy()` is synchronous and returns void — api-sketch §9.7. */
  readonly storage: { destroy(): void };
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

      /*
       * Its own try, and that is the whole point: sharing one with pool.end
       * means a pool that fails to close skips this and leaves the storage
       * client's sockets open. `destroy()` is synchronous, so an unguarded
       * throw escapes this async function and reaches index.ts's
       * `void shutdown(s)` as an unhandled rejection, which Node 22 treats
       * as fatal — a failed shutdown would terminate rather than exit 1.
       */
      try {
        deps.storage.destroy();
      } catch (error) {
        deps.log(`Error in storage shutdown with signal ${signal}: ${error}`);
        failed = true;
      }

      clearTimeout(timer);
      process.exitCode = failed ? 1 : 0;
    }
  };
}
