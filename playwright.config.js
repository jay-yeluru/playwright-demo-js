// @ts-check
const { devices } = require("@playwright/test");

const isCI = !!process.env.CI;

/** @type {import('@playwright/test').PlaywrightTestConfig} */
const config = {
  testDir: "./e2e",
  outputDir: "test-artifacts",
  timeout: 30 * 1000,
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: isCI ? 2 : undefined,

  expect: {
    timeout: 5000,
  },

  use: {
    actionTimeout: 0,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  reporter:
    /** @type {import('@playwright/test').PlaywrightTestConfig['reporter']} */ ([
      ["html", { outputFolder: "reports", open: "never" }],
      ["json", { outputFile: "reports/test-results.json" }],
      ...(isCI ? [["github", {}]] : [["list", {}]]),
    ]),

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], headless: true },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], headless: true },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], headless: true },
    },
    {
      name: "edge",
      use: { ...devices["Desktop Edge"], channel: "msedge", headless: true },
    },
  ],
};

module.exports = config;
