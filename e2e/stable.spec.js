// @ts-check
/**
 * stable.spec.js
 *
 * Always-green tests — these NEVER fail intentionally.
 * Kept deliberately small so CI has a realistic chance of a 100% PASS run.
 * playwright.dev coverage lives in bdd.spec.js.
 */
const { test, expect } = require('@playwright/test');

test.describe('Stable — Example.com', () => {
    test('page title is "Example Domain" @smoke', async ({ page }) => {
        await page.goto('https://example.com');
        await expect(page).toHaveTitle(/Example Domain/);
    });

    test('h1 is visible and correct @smoke', async ({ page }) => {
        await page.goto('https://example.com');
        await expect(page.locator('h1')).toHaveText('Example Domain');
    });

    test('page has at least one paragraph and link', async ({ page }) => {
        await page.goto('https://example.com');
        await expect(page.locator('p').first()).toBeVisible();
        await expect(page.locator('a').first()).toBeVisible();
    });
});
