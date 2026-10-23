/*
 * The licences screen: reached from the album list, every link opens its
 * licence text from this origin, and nothing trips the CSP.
 */
import { expect, test } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { LICENCES } from "../../src/lib/licences.ts";
import { watch } from "./helpers.ts";

test("every licence the app ships is linked and served as text", async ({ page, request }) => {
  const violations = await watch(page);
  await page.goto("/licences");
  await expect(page.getByRole("heading", { name: en["licences.title"] })).toBeVisible();
  for (const l of LICENCES) {
    const link = page.getByRole("link", { name: en[l.covers] as string });
    await expect(link).toHaveAttribute("href", `/licenses/${l.file}`);
    const res = await request.get(`/licenses/${l.file}`);
    expect(res.status(), l.file).toBe(200);
    expect((await res.text()).trim().length, l.file).toBeGreaterThan(0);
  }
  await page.getByRole("link", { name: en[LICENCES[0]!.covers] as string }).click();
  await expect(page).toHaveURL(new RegExp(`/licenses/${LICENCES[0]!.file}$`));
  expect(await violations()).toEqual([]);
});
