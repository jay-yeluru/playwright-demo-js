// @ts-check
/**
 * bdd.spec.js  — BDD-style scenarios
 *
 * - test.describe  → Feature groups
 * - test.step      → Given / When / Then / And
 * - { tag }        → @smoke @regression @p1 @p2 + domain tags
 * - testInfo.attach → screenshots embedded in HTML report
 *
 * Kept lean: each scenario navigates to one URL only.
 */
const { test, expect } = require('@playwright/test');

/** Attach a full-page screenshot to the HTML report.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string} label
 */
async function screenshot(page, testInfo, label) {
    const buf = await page.screenshot({ fullPage: false }); // viewport only — faster
    await testInfo.attach(label, { body: buf, contentType: 'image/png' });
}

// ═════════════════════════════════════════════════════════════
// Feature: Example.com Homepage
// ═════════════════════════════════════════════════════════════
test.describe('Feature: Example.com Homepage', () => {

    test(
        'Scenario: Page has correct title, heading and a link',
        { tag: ['@smoke', '@p1', '@homepage'] },
        async ({ page }, testInfo) => {

            await test.step('Given I navigate to https://example.com', async () => {
                await page.goto('https://example.com');
            });

            await test.step('Then the title should be "Example Domain"', async () => {
                await expect(page).toHaveTitle(/Example Domain/);
            });

            await test.step('And the heading should read "Example Domain"', async () => {
                await expect(page.locator('h1')).toHaveText('Example Domain');
            });

            await test.step('And the page should contain at least one link', async () => {
                const href = await page.locator('a').first().getAttribute('href');
                expect(href).toBeTruthy();
                await screenshot(page, testInfo, 'homepage — title, heading & link');
            });
        }
    );

    test(
        'Scenario: Page has visible paragraph content',
        { tag: ['@regression', '@p2', '@content'] },
        async ({ page }, testInfo) => {

            await test.step('Given I navigate to https://example.com', async () => {
                await page.goto('https://example.com');
            });

            await test.step('Then at least one paragraph should be visible', async () => {
                await expect(page.locator('p').first()).toBeVisible();
                await screenshot(page, testInfo, 'homepage — content paragraph');
            });
        }
    );
});

// ═════════════════════════════════════════════════════════════
// Feature: Playwright.dev Navigation
// ═════════════════════════════════════════════════════════════
test.describe('Feature: Playwright.dev Navigation', () => {

    test(
        'Scenario: Landing page has branding and "Get started" link',
        { tag: ['@smoke', '@p1', '@navigation'] },
        async ({ page }, testInfo) => {

            await test.step('Given I open https://playwright.dev', async () => {
                await page.goto('https://playwright.dev/');
            });

            await test.step('Then the title should mention "Playwright"', async () => {
                await expect(page).toHaveTitle(/Playwright/);
            });

            await test.step('And the "Get started" link should point to /docs/intro', async () => {
                await expect(
                    page.getByRole('link', { name: 'Get started' })
                ).toHaveAttribute('href', '/docs/intro');
                await screenshot(page, testInfo, 'playwright.dev — landing page');
            });
        }
    );

    test(
        'Scenario: "Get started" click navigates to intro docs',
        { tag: ['@smoke', '@p1', '@navigation'] },
        async ({ page }, testInfo) => {

            await test.step('Given I am on the Playwright homepage', async () => {
                await page.goto('https://playwright.dev/');
            });

            await test.step('When I click "Get started"', async () => {
                await page.getByRole('link', { name: 'Get started' }).click();
            });

            await test.step('Then the URL should contain "/intro" and h1 should be visible', async () => {
                await expect(page).toHaveURL(/.*intro/);
                await expect(page.locator('h1').first()).toBeVisible();
                await screenshot(page, testInfo, 'playwright.dev — intro page');
            });
        }
    );
});

// ═════════════════════════════════════════════════════════════
// Feature: Performance & Accessibility
// ═════════════════════════════════════════════════════════════
test.describe('Feature: Performance & Accessibility', () => {

    test(
        'Scenario: Page loads quickly and has a single h1',
        { tag: ['@regression', '@p2', '@a11y', '@performance'] },
        async ({ page }, testInfo) => {

            await test.step('Given I navigate to https://example.com and measure load time', async () => {
                const t0 = Date.now();
                await page.goto('https://example.com');
                const elapsed = Date.now() - t0;
                console.log(`  → Load time: ${elapsed}ms`);
                expect(elapsed).toBeLessThan(10_000);
            });

            await test.step('Then the page should have exactly one h1', async () => {
                await expect(page.locator('h1')).toHaveCount(1);
            });

            await test.step('And interactive elements should have ARIA roles', async () => {
                const count = await page.getByRole('link').count();
                expect(count).toBeGreaterThan(0);
                await screenshot(page, testInfo, 'a11y & perf — example.com');
            });
        }
    );
});
