// @ts-check
const { test, expect } = require('@playwright/test');

// ─────────────────────────────────────────────────────────────
// ✅ ALWAYS PASSING TESTS
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

test('example.com page loads and has content', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page.locator('p').first()).toContainText('illustrative examples');
});

// ─────────────────────────────────────────────────────────────
// ❌ RANDOM FAILING TESTS  (fail ~40% of runs — no retry)
// These simulate real intermittent regressions.
// ─────────────────────────────────────────────────────────────

test('INTERMITTENT - page title check', async ({ page }) => {
  await page.goto('https://example.com');
  if (Math.random() < 0.4) {
    // Simulated regression: wrong title expectation
    await expect(page).toHaveTitle(/My App/, { timeout: 3000 });
  } else {
    await expect(page).toHaveTitle(/Example Domain/);
  }
});

test('INTERMITTENT - element visibility check', async ({ page }) => {
  await page.goto('https://example.com');
  if (Math.random() < 0.4) {
    // Simulated regression: element doesn't exist
    await expect(page.locator('#login-button')).toBeVisible({ timeout: 3000 });
  } else {
    await expect(page.locator('h1')).toBeVisible();
  }
});

test('INTERMITTENT - heading text assertion', async ({ page }) => {
  await page.goto('https://example.com');
  if (Math.random() < 0.4) {
    // Simulated regression: wrong heading
    await expect(page.locator('h1')).toHaveText('Wrong Domain', { timeout: 3000 });
  } else {
    await expect(page.locator('h1')).toHaveText('Example Domain');
  }
});

// ─────────────────────────────────────────────────────────────
// ⚠️  FLAKY TESTS  (fail first attempt ~50%, pass on retry)
// ─────────────────────────────────────────────────────────────

test('FLAKY - random transient failure @smoke', async ({ page }) => {
  await page.goto('https://example.com');
  await expect(page).toHaveTitle(/Example Domain/);

  if (Math.random() < 0.5) {
    throw new Error('Simulated transient failure — this test is intentionally flaky');
  }
});

test('FLAKY - random assertion failure', async ({ page }) => {
  await page.goto('https://example.com');

  if (Math.random() < 0.5) {
    // Wrong: page has text that is different
    await expect(page.locator('p').first()).toHaveText('This domain does not exist.', { timeout: 3000 });
  } else {
    await expect(page.locator('p').first()).toContainText('illustrative examples');
  }
});
