import { describe, expect, it } from "vitest";
import { isToleratedAbortReport } from "./browser/abort-report";

const URL_A = "http://localhost:3000/health";
const report = (u: string) => `Fetch API cannot load ${u} due to access control checks.`;

describe("the one tolerated WebKit report (test/browser/abort-report.ts)", () => {
  const aborted = new Set([URL_A]);

  it("is tolerated in WebKit, for a URL the test aborted, in exactly that shape", () => {
    expect(isToleratedAbortReport(report(URL_A), aborted, "webkit")).toBe(true);
  });

  it("is never tolerated in another browser", () => {
    expect(isToleratedAbortReport(report(URL_A), aborted, "chromium")).toBe(false);
    expect(isToleratedAbortReport(report(URL_A), aborted, "firefox")).toBe(false);
  });

  it("is never tolerated for a URL the test did not abort: a real CORS failure reads the same", () => {
    expect(isToleratedAbortReport(report("http://localhost:3000/v1/albums"), aborted, "webkit")).toBe(false);
    expect(isToleratedAbortReport(report(URL_A + "?x"), aborted, "webkit")).toBe(false);
    expect(isToleratedAbortReport(report(URL_A), new Set(), "webkit")).toBe(false);
  });

  it("is never tolerated in any other wording", () => {
    for (const m of [
      `Origin http://127.0.0.1:4173 is not allowed by Access-Control-Allow-Origin. ${report(URL_A)}`,
      `${report(URL_A)} Status code: 500`,
      `XMLHttpRequest cannot load ${URL_A} due to access control checks.`,
      `Fetch API cannot load ${URL_A} due to access control checks`,
      "access control checks",
      "TypeError: Load failed",
    ]) {
      expect(isToleratedAbortReport(m, aborted, "webkit"), m).toBe(false);
    }
  });
});
