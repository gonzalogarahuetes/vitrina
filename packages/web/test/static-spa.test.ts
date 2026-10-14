import { describe, expect, it } from "vitest";
import { forbiddenSourcePaths, parseApiOrigin } from "../vite-plugins";
import * as rootLayout from "../src/routes/+layout";
import * as recipientPage from "../src/routes/v/+page";

describe("a static single-page app", () => {
  it("renders nothing on a server and prerenders nothing", () => {
    expect(rootLayout.ssr).toBe(false);
    expect(rootLayout.prerender).toBe(false);
  });

  it("reserves /v/ with its trailing slash (invite spec §2)", () => {
    expect(recipientPage.trailingSlash).toBe("always");
  });

  it("refuses every kind of SvelteKit server file and a service worker", () => {
    const forbidden = [
      "src/routes/+server.ts",
      "src/routes/api/+server.js",
      "src/routes/+page.server.ts",
      "src/routes/+layout.server.ts",
      "src/hooks.server.ts",
      "src/lib/server",
      "src/lib/server/db.ts",
      "src/lib/secrets.server.ts",
      "src/lib/server.ts",
      "src/lib/data.remote.ts",
      "src/service-worker.ts",
      "src/service-worker/index.ts",
    ];
    expect(forbiddenSourcePaths(forbidden)).toEqual(forbidden);
  });

  it("allows what a client-only app has", () => {
    const allowed = [
      "src/routes/+page.svelte",
      "src/routes/+layout.ts",
      "src/routes/v/+page.ts",
      "src/hooks.client.ts",
      "src/lib/api/client.ts",
      "src/lib/observer.ts",
    ];
    expect(forbiddenSourcePaths(allowed)).toEqual([]);
  });
});

describe("VITE_API_ORIGIN", () => {
  it("is required", () => {
    expect(() => parseApiOrigin(undefined)).toThrow();
    expect(() => parseApiOrigin("")).toThrow();
  });
  it("is https unless localhost, and a bare origin", () => {
    expect(parseApiOrigin("https://api.vitrina.test/")).toBe("https://api.vitrina.test");
    expect(parseApiOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(() => parseApiOrigin("http://api.vitrina.test")).toThrow();
    expect(() => parseApiOrigin("https://api.vitrina.test/v1")).toThrow();
    expect(() => parseApiOrigin("https://api.vitrina.test/#k=x")).toThrow();
  });
});
