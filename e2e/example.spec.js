// @ts-check
const { test, expect } = require('@playwright/test');

// ─────────────────────────────────────────────────────────────
// ✅ PASSING TESTS
// ─────────────────────────────────────────────────────────────

test('playwright.dev homepage has title and links to intro page @smoke', async ({ page }) => {
  await page.goto('https://playwright.dev/');
  await expect(page).toHaveTitle(/Playwright/);

  const getStarted = page.getByRole('link', { name: 'Get started' });
  await expect(getStarted).toHaveAttribute('href', '/docs/intro');
  await getStarted.click();
  await expect(page).toHaveURL(/.*intro/);
});

test('example.com renders the correct heading @smoke', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example Domain/);
  await expect(page.locator('h1')).toHaveText('Example Domain');
});

test('example.com has a "More information" link', async ({ page }) => {
  await page.goto('https://example.com');
  const link = page.getByRole('link', { name: /more information/i });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', /iana\.org/);
});

// ─────────────────────────────────────────────────────────────
// ❌ FAILING TESTS  (intentional — for dashboard demo)
// ─────────────────────────────────────────────────────────────

test('FAIL - wrong page title assertion', async ({ page }) => {
  await page.goto('https://example.com');
  // Deliberately wrong — title is "Example Domain", not "My App"
  await expect(page).toHaveTitle(/My App/, { timeout: 3000 });
});

test('FAIL - non-existent element on example.com', async ({ page }) => {
  await page.goto('https://example.com');
  // This element does not exist on the page
  await expect(page.locator('#login-button')).toBeVisible({ timeout: 3000 });
});

test('FAIL - wrong heading text on example.com', async ({ page }) => {
  await page.goto('https://example.com');
  // Actual heading is "Example Domain"
  await expect(page.locator('h1')).toHaveText('Wrong Domain', { timeout: 3000 });
});

// ─────────────────────────────────────────────────────────────
// ⚠️  FLAKY TESTS  (Math.random — no added network delay)
// ─────────────────────────────────────────────────────────────

test('FLAKY - random failure 50% of the time', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example Domain/);

  if (Math.random() < 0.5) {
    throw new Error('Simulated transient failure — this test is intentionally flaky');
  }
});

test('FLAKY - random wrong assertion 50% of the time', async ({ page }) => {
  await page.goto('https://example.com');

  if (Math.random() < 0.5) {
    // Wrong: page has only one <p> with a different text
    await expect(page.locator('p').first()).toHaveText('This domain does not exist.', { timeout: 3000 });
  } else {
    await expect(page.locator('p').first()).toContainText('illustrative examples');
  }
});
