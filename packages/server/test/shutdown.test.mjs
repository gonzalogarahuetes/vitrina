/*
 * Graceful shutdown. The property is an ORDER — the HTTP server drains before
 * the pool closes — and a set of paths that must still reach the pool.
 *
 * CAUTION: the deadline calls process.exit, which would kill the test runner
 * itself. The timeout case stubs process.exit and restores it in a finally;
 * if that restore is ever removed, a later failure in this file takes the
 * whole run down with an exit code and no report.
 *
 * Hermetic: fakes throughout, against dist/.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createShutdown } from "../dist/shutdown.js";

/** Every call, in order, across both fakes — so ordering is assertable. */
function recorder() {
  const calls = [];
  const log = [];
  return {
    calls,
    log,
    /** `behaviour` lets one step hang or reject without touching the other. */
    make({ close = async () => {}, end = async () => {} } = {}) {
      return {
        app: {
          close: async () => {
            calls.push("app.close:start");
            await close();
            calls.push("app.close:done");
          },
        },
        pool: {
          end: async () => {
            calls.push("pool.end:start");
            await end();
            calls.push("pool.end:done");
          },
        },
        log: (message) => log.push(message),
      };
    },
  };
}

/** process.exitCode leaks between tests, so each case starts from a known one. */
let originalExitCode;
beforeEach(() => {
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("createShutdown", () => {
  describe("the happy path", () => {
    it("closes the server fully BEFORE ending the pool", async () => {
      // The one ordering rule. Ending the pool first fails every in-flight
      // query with a 500 — the outcome graceful shutdown exists to avoid.
      const r = recorder();
      await createShutdown(r.make())("SIGTERM");

      assert.deepEqual(r.calls, [
        "app.close:start",
        "app.close:done",
        "pool.end:start",
        "pool.end:done",
      ]);
    });

    it("exits zero", async () => {
      const r = recorder();
      await createShutdown(r.make())("SIGTERM");

      assert.equal(process.exitCode, 0);
    });

    it("does not overlap the two: the pool waits for close to resolve", async () => {
      // A close() that resolves late must still precede pool.end entirely.
      // Without the await this interleaves and the assertion above passes by
      // luck of scheduling.
      const r = recorder();
      const slowClose = () => new Promise((resolve) => setTimeout(resolve, 20));
      await createShutdown(r.make({ close: slowClose }))("SIGTERM");

      assert.ok(
        r.calls.indexOf("app.close:done") < r.calls.indexOf("pool.end:start"),
        `overlapped: ${r.calls.join(" → ")}`,
      );
    });
  });

  describe("a second signal", () => {
    it("does nothing — SIGTERM then SIGINT shuts down once", async () => {
      // Both signals reach a container being stopped by hand. A second pass
      // would close an already-closed app and end an ended pool, both of
      // which reject.
      const r = recorder();
      const shutdown = createShutdown(r.make());

      await shutdown("SIGTERM");
      await shutdown("SIGINT");

      assert.deepEqual(r.calls, [
        "app.close:start",
        "app.close:done",
        "pool.end:start",
        "pool.end:done",
      ]);
    });

    it("is per instance, not per module", async () => {
      // The flag lives in the closure. At module scope, this file's own cases
      // would interfere with each other and most of them would assert nothing.
      const first = recorder();
      const second = recorder();
      await createShutdown(first.make())("SIGTERM");
      await createShutdown(second.make())("SIGTERM");

      assert.equal(second.calls.length, 4, "a fresh instance must shut down too");
    });
  });

  describe("when app.close fails", () => {
    it("still ends the pool", async () => {
      // The connections have to be released whatever the HTTP side did.
      const r = recorder();
      const deps = r.make({ close: async () => { throw new Error("close exploded"); } });
      await createShutdown(deps)("SIGTERM");

      assert.deepEqual(r.calls, ["app.close:start", "pool.end:start", "pool.end:done"]);
    });

    it("exits non-zero", async () => {
      // The exit code is the only signal an orchestrator reads.
      const r = recorder();
      await createShutdown(r.make({ close: async () => { throw new Error("close exploded"); } }))("SIGTERM");

      assert.equal(process.exitCode, 1);
    });

    it("logs the failure through the injected logger", async () => {
      const r = recorder();
      await createShutdown(r.make({ close: async () => { throw new Error("close exploded"); } }))("SIGTERM");

      assert.equal(r.log.length, 1);
      assert.match(r.log[0], /close exploded/);
      assert.match(r.log[0], /SIGTERM/, "the signal belongs in the line that reports the failure");
    });
  });

  describe("when pool.end fails", () => {
    it("is reported and exits non-zero, even though the server drained", async () => {
      const r = recorder();
      await createShutdown(r.make({ end: async () => { throw new Error("pool exploded"); } }))("SIGINT");

      assert.equal(process.exitCode, 1);
      assert.match(r.log[0], /pool exploded/);
    });

    it("does not reject — index.ts calls this as void, so a rejection is unhandled", async () => {
      const r = recorder();
      const shutdown = createShutdown(r.make({ end: async () => { throw new Error("pool exploded"); } }));

      await assert.doesNotReject(() => shutdown("SIGTERM"));
    });
  });

  describe("the deadline", () => {
    it("hard-exits when close never settles", async () => {
      // Stubbed, or this kills the runner. Restored in the finally below —
      // see the caution at the top of this file.
      const realExit = process.exit;
      const exits = [];
      process.exit = (code) => { exits.push(code); };

      try {
        const r = recorder();
        const neverSettles = () => new Promise(() => {});
        const shutdown = createShutdown({ ...r.make({ close: neverSettles }), timeoutMs: 10 });

        void shutdown("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.deepEqual(exits, [1], "the deadline must exit(1), not set exitCode on a wedged loop");
        assert.match(r.log.at(-1), /timed out after 10ms/);
      } finally {
        process.exit = realExit;
      }
    });

    it("does not fire on a shutdown that completed", async () => {
      // The timer is cleared, so a process lingering for other reasons is not
      // killed after the fact by a deadline for work that already finished.
      const realExit = process.exit;
      const exits = [];
      process.exit = (code) => { exits.push(code); };

      try {
        const r = recorder();
        await createShutdown({ ...r.make(), timeoutMs: 10 })("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.deepEqual(exits, [], "a cleared timer must not fire after a clean shutdown");
      } finally {
        process.exit = realExit;
      }
    });
  });
});
