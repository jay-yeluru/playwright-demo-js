// @ts-check
/**
 * stable.spec.js
 *
 * Always-green test suite — these tests NEVER fail intentionally.
 * Their purpose is to ensure some CI runs come out as 100% PASS,
 * which in turn exercises the "passing run" retention path and keeps
 * the dashboard stats meaningful.
 */
const { test, expect } = require('@playwright/test');

test.describe('Stable — Example.com', () => {
    test('page title is "Example Domain" @smoke', async ({ page }) => {
        await page.goto('https://example.com');
        await expect(page).toHaveTitle(/Example Domain/);
    });

    test('h1 is visible and correct @smoke', async ({ page }) => {
        await page.goto('https://example.com');
        await expect(page.locator('h1')).toBeVisible();
        await expect(page.locator('h1')).toHaveText('Example Domain');
    });

    test('page has at least one paragraph', async ({ page }) => {
        await page.goto('https://example.com');
        await expect(page.locator('p').first()).toBeVisible();
    });

    test('page has a link', async ({ page }) => {
        await page.goto('https://example.com');
        await expect(page.locator('a').first()).toBeVisible();
    });
});

test.describe('Stable — Playwright.dev', () => {
    test('homepage title contains "Playwright" @smoke', async ({ page }) => {
        await page.goto('https://playwright.dev/');
        await expect(page).toHaveTitle(/Playwright/);
    });

    test('"Get started" link points to /docs/intro @smoke', async ({ page }) => {
        await page.goto('https://playwright.dev/');
        const link = page.getByRole('link', { name: 'Get started' });
        await expect(link).toBeVisible();
        await expect(link).toHaveAttribute('href', '/docs/intro');
    });

    test('docs page loads successfully', async ({ page }) => {
        await page.goto('https://playwright.dev/docs/intro');
        await expect(page).toHaveURL(/.*intro/);
        await expect(page.locator('h1').first()).toBeVisible();
    });
});
