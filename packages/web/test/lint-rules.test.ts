/*
 * The lint rules that carry a security decision, run through ESLint on code
 * that breaks them. If a rule is deleted, misconfigured or scoped to the wrong
 * files, this fails, where a clean `pnpm lint` would say nothing.
 */
import { ESLint } from "eslint";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd });

async function messages(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.message);
}

const SNAPSHOT = /No `snapshot` export/;

describe("no SvelteKit snapshot in any route", () => {
  const svelte = (script: string) => `<script lang="ts">\n${script}\n</script>\n<p>x</p>\n`;
  const violations: [string, string, string][] = [
    ["a const in +page.svelte", "src/routes/v/+page.svelte", svelte("  export const snapshot = { capture: () => 1, restore: () => {} };")],
    ["a let in +layout.svelte", "src/routes/+layout.svelte", svelte("  export let snapshot = { capture: () => 1, restore: () => {} };")],
    ["a renamed export", "src/routes/v/+page.svelte", svelte("  const s = { capture: () => 1, restore: () => {} };\n  export { s as snapshot };")],
    ["a nested route", "src/routes/a/b/+page.svelte", svelte("  export const snapshot = { capture: () => 1, restore: () => {} };")],
    ["a function", "src/routes/v/+page.svelte", svelte("  export function snapshot() {}")],
  ];

  for (const [what, filePath, code] of violations) {
    it(`refuses ${what}`, async () => {
      expect(await messages(code, filePath)).toEqual(expect.arrayContaining([expect.stringMatching(SNAPSHOT)]));
    }, 30_000);
  }

  it("allows an unrelated export and a local named snapshot", async () => {
    const code = svelte("  const snapshot = 1;\n  void snapshot;");
    expect((await messages(code, "src/routes/v/+page.svelte")).filter((m) => SNAPSHOT.test(m))).toEqual([]);
  }, 30_000);
});

describe("sessionStorage only in src/lib/session/owner-session.ts (flows §1.1)", () => {
  const STORAGE = /Nothing is stored on this device except the owner token/;
  const uses = ['sessionStorage.setItem("k", "v");', 'window.sessionStorage.setItem("k", "v");', 'globalThis.sessionStorage.getItem("k");'];

  for (const code of uses) {
    for (const filePath of ["src/lib/owner/session.ts", "src/routes/+page.svelte", "src/lib/recipient/entry.ts", "src/lib/session/other.ts"]) {
      it(`refuses \`${code}\` in ${filePath}`, async () => {
        const source = filePath.endsWith(".svelte") ? `<script lang="ts">\n${code}\n</script>\n` : code;
        expect(await messages(source, filePath)).toEqual(expect.arrayContaining([expect.stringMatching(STORAGE)]));
      }, 30_000);
    }
    it(`allows \`${code}\` in the session module`, async () => {
      expect((await messages(code, "src/lib/session/owner-session.ts")).filter((m) => STORAGE.test(m))).toEqual([]);
    }, 30_000);
  }

  it("refuses localStorage even in the session module", async () => {
    expect(await messages('localStorage.setItem("k", "v");', "src/lib/session/owner-session.ts")).toEqual(
      expect.arrayContaining([expect.stringMatching(STORAGE)]),
    );
  }, 30_000);
});
