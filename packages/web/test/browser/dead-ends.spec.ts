/*
 * Dead ends that offer the next step: the WASM that will not start (flows §2's
 * could-not-derive family) is worded for the path it is on and offers a
 * reload, and a credential form submitted with a field empty says why rather
 * than doing nothing.
 */
import { expect, test, type Page } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { cutTheApi, watch } from "./helpers.ts";

/** The envelope is inlined (virtual:envelope-wasm), so its instantiation is what fails, as an allocation failure would. */
async function refuseWasm(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const refuse = (): Promise<never> => Promise.reject(new Error("refused by the test"));
    WebAssembly.instantiate = refuse as typeof WebAssembly.instantiate;
    WebAssembly.instantiateStreaming = refuse as typeof WebAssembly.instantiateStreaming;
  });
}

const reload = (page: Page) => page.getByRole("button", { name: en["derive.failed.retry"] });

test("the WASM will not start: the owner path in the owner's words, with a reload", async ({ page }) => {
  const aborted = new Set<string>();
  const violations = await watch(page, { aborted });
  await cutTheApi(page, aborted);
  await refuseWasm(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: en["derive.failed.owner"] })).toBeVisible();
  await expect(page.getByText(en["derive.failed"])).toHaveCount(0);
  await reload(page).click();
  // Still refused after the reload: the same screen, the same way out.
  await expect(page.getByRole("heading", { name: en["derive.failed.owner"] })).toBeVisible();
  await expect(reload(page)).toBeVisible();
  expect((await violations()).filter((v) => !v.includes("refused by the test"))).toEqual([]);
});

test("the WASM will not start: the recipient path in the recipient's words, with a reload", async ({ page }) => {
  const aborted = new Set<string>();
  const violations = await watch(page, { aborted });
  await cutTheApi(page, aborted);
  await refuseWasm(page);
  await page.goto("/v/");
  await expect(page.getByRole("heading", { name: en["derive.failed"] })).toBeVisible();
  await expect(page.getByText(en["derive.failed.owner"])).toHaveCount(0);
  await expect(reload(page)).toBeVisible();
  expect((await violations()).filter((v) => !v.includes("refused by the test"))).toEqual([]);
});

test("sign-in and sign-up submitted with a field empty say why, and send nothing", async ({ page }) => {
  const aborted = new Set<string>();
  await cutTheApi(page, aborted);
  await page.goto("/");

  const signin = page.getByRole("button", { name: en["signin.submit"] });
  await expect(signin).toBeEnabled();
  await signin.click();
  await expect(page.getByRole("alert").filter({ hasText: en["signin.empty"] })).toBeVisible();
  await page.getByLabel(en["signin.email.label"]).fill("someone@example.com");
  await signin.click();
  await expect(page.getByRole("alert").filter({ hasText: en["signin.empty"] })).toBeVisible();
  // Both filled: the message goes, before anything is sent.
  await page.getByLabel(en["signin.password.label"], { exact: true }).fill("x");
  await expect(page.getByText(en["signin.empty"])).toHaveCount(0);

  await page.getByRole("button", { name: en["signin.to-signup"] }).click();
  const signup = page.getByRole("button", { name: en["signup.submit"] });
  await expect(signup).toBeEnabled();
  await signup.click();
  await expect(page.getByRole("alert").filter({ hasText: en["signup.empty"] })).toBeVisible();
  expect([...aborted], "requests sent").toEqual([]);
});
