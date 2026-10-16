/*
 * The one page error the browser check tolerates, and only this narrowly.
 *
 * WebKit sometimes reports a fetch that the TEST aborted (cutTheApi) as an
 * uncaught page error when the page navigates away mid-request, even though
 * the app handled the rejection. The report reads exactly:
 *
 *   Fetch API cannot load <url> due to access control checks.
 *
 * A real CORS failure produces the same words. So the report is tolerated
 * only when all three hold: the browser is WebKit, the message has exactly
 * that shape, and <url> is one this test aborted itself. "access control
 * checks" is never filtered in general.
 *
 * No imports, so the unit test (test/abort-report.test.ts) runs under vitest.
 */

const WEBKIT_ABORT = /^Fetch API cannot load (\S+) due to access control checks\.$/;

export function isToleratedAbortReport(message: string, aborted: ReadonlySet<string>, browserName: string): boolean {
  if (browserName !== "webkit") return false;
  const url = WEBKIT_ABORT.exec(message)?.[1];
  return url !== undefined && aborted.has(url);
}
