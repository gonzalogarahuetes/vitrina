/*
 * The real-browser check (test/browser/): behaviour only a browser shows, run
 * against the production build. Chromium, and WebKit as the closest CI gets to
 * iPhone Safari, which is still an approximation, not Safari.
 *
 * Needs build/ first: `pnpm --filter @vitrina/web build`.
 */
import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.spec.ts",
  forbidOnly: Boolean(process.env["CI"]),
  retries: 0,
  reporter: process.env["CI"] ? [["list"], ["github"]] : "list",
  // A trace only when a test fails; CI uploads test-results/ on failure. The
  // invite values in the spec are fixtures, so a trace holds no real secret.
  use: { baseURL: `http://127.0.0.1:${PORT}`, trace: "retain-on-failure" },
  projects: [
    // The CSP authority. WebKit does not report blocked style attributes from
    // template markup, so only Chromium's CSP results count (see the spec).
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // For storage and the key-in-memory page: the closest CI gets to iPhone Safari.
    { name: "webkit", use: { ...devices["iPhone 13"] } },
  ],
  webServer: {
    command: "node test/browser/serve.mjs",
    url: `http://127.0.0.1:${PORT}/`,
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env["CI"],
  },
});
