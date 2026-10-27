/*
 * The interface language in a real browser (brief §15): the production build,
 * Chromium and WebKit, the device language set as the browser's locale.
 *
 *   1. The first language is the device's own (navigator.languages), with
 *      English for a device the app has no language for.
 *   2. <html lang> follows it, and follows a switch, so a screen reader
 *      pronounces the page in the language it is in.
 *   3. A switch lasts for the visit only: it writes nothing anywhere
 *      (test/storage-allowlist.ts judges a dump), and a reload starts from the
 *      device language again (decided 26 October 2026).
 *   4. Every static screen is in Spanish on a Spanish device: the dead page,
 *      sign-in, the licences.
 *
 * The recipient's path in Spanish is in recipient-reload.spec.ts (it needs
 * that file's relay), and the passphrase language's default in
 * owner-invites.spec.ts.
 */
import { expect, test, type Page } from "@playwright/test";
import { en } from "../../src/lib/copy/en.ts";
import { es } from "../../src/lib/copy/es.ts";
import { autonym } from "../../src/lib/copy/format.ts";
import { LICENCES } from "../../src/lib/licences.ts";
import { storageViolations } from "../storage-allowlist.ts";
import { dumpStorage, text, watch } from "./helpers.ts";

const ENGLISH = autonym("en");
const SPANISH = autonym("es");

const htmlLang = (page: Page) => page.evaluate(() => document.documentElement.lang);
const choice = (page: Page, name: string) => page.locator("[data-language-switch]").first().getByRole("button", { name, exact: true });

async function expectLanguage(page: Page, lang: "en" | "es"): Promise<void> {
  await expect.poll(() => htmlLang(page)).toBe(lang);
  await expect(page.locator("[data-language-switch]").first()).toHaveAttribute("aria-label", (lang === "en" ? en : es)["language.label"]);
  await expect(choice(page, lang === "en" ? ENGLISH : SPANISH)).toHaveAttribute("aria-pressed", "true");
  await expect(choice(page, lang === "en" ? SPANISH : ENGLISH)).toHaveAttribute("aria-pressed", "false");
}

test.describe("a device set to Spanish", () => {
  test.use({ locale: "es-ES" });

  test("starts in Spanish, and a switch to English lasts for the visit only, storing nothing", async ({ page }) => {
    const violations = await watch(page);
    await page.goto("/v/");
    await text(es.dead)(page);
    await expectLanguage(page, "es");

    await choice(page, ENGLISH).click();
    await text(en.dead)(page);
    await expectLanguage(page, "en");
    expect(storageViolations(await dumpStorage(page)), "the choice is stored nowhere").toEqual([]);

    await page.reload();
    await page.waitForLoadState("load");
    await text(es.dead)(page);
    await expectLanguage(page, "es");
    expect(storageViolations(await dumpStorage(page))).toEqual([]);
    expect(await violations()).toEqual([]);
  });

  test("every static screen is in Spanish: sign-in and the licences, each licence described in Spanish", async ({ page }) => {
    const violations = await watch(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: es["signin.title"] })).toBeVisible();
    await expect(page.getByLabel(es["signin.email.label"])).toBeVisible();
    await expectLanguage(page, "es");

    await page.goto("/licences");
    await expect(page.getByRole("heading", { name: es["licences.title"] })).toBeVisible();
    await expect(page.getByText(es["licences.intro"])).toBeVisible();
    for (const l of LICENCES) await expect(page.getByRole("link", { name: es[l.covers] as string })).toHaveAttribute("href", `/licenses/${l.file}`);
    await expect(page.getByRole("link", { name: es["licences.back"] })).toBeVisible();
    await expectLanguage(page, "es");
    expect(await violations()).toEqual([]);
  });

  test("a switch re-renders the screen in place: no reload, no navigation", async ({ page }) => {
    const violations = await watch(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: es["signin.title"] })).toBeVisible();
    await page.getByLabel(es["signin.email.label"]).fill("parent@example.com");
    const navigations: string[] = [];
    page.on("framenavigated", (f) => navigations.push(f.url()));

    await choice(page, ENGLISH).click();
    await expect(page.getByRole("heading", { name: en["signin.title"] })).toBeVisible();
    await expect(page.getByLabel(en["signin.email.label"]), "what was typed survives the switch").toHaveValue("parent@example.com");
    await choice(page, SPANISH).click();
    await expect(page.getByRole("heading", { name: es["signin.title"] })).toBeVisible();
    expect(navigations).toEqual([]);
    expect(storageViolations(await dumpStorage(page))).toEqual([]);
    expect(await violations()).toEqual([]);
  });
});

test.describe("a device set to English", () => {
  test.use({ locale: "en-GB" });

  test("starts in English, and a switch to Spanish lasts for the visit only, storing nothing", async ({ page }) => {
    const violations = await watch(page);
    await page.goto("/v/");
    await text(en.dead)(page);
    await expectLanguage(page, "en");

    await choice(page, SPANISH).click();
    await text(es.dead)(page);
    await expectLanguage(page, "es");
    expect(storageViolations(await dumpStorage(page))).toEqual([]);

    await page.reload();
    await page.waitForLoadState("load");
    await text(en.dead)(page);
    await expectLanguage(page, "en");
    expect(await violations()).toEqual([]);
  });
});

test.describe("a device in a language the app does not have", () => {
  test.use({ locale: "fr-FR" });

  test("starts in English, the reference text", async ({ page }) => {
    const violations = await watch(page);
    await page.goto("/v/");
    await text(en.dead)(page);
    await expectLanguage(page, "en");
    expect(await violations()).toEqual([]);
  });
});
