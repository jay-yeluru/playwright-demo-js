# 🎭 Playwright Demo JS

A production-grade end-to-end test automation framework built with [Playwright](https://playwright.dev) and JavaScript, featuring a fully automated CI/CD pipeline with a live test dashboard hosted on GitHub Pages.

🔗 **[Live Dashboard](https://jay-yeluru.github.io/playwright-demo-js/)**

---

## 📋 Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Running Tests](#running-tests)
- [CI/CD Pipeline](#cicd-pipeline)
- [Test Dashboard](#test-dashboard)
- [Configuration](#configuration)

---

## ✨ Features

- Cross-browser testing across Chrome, Firefox, Safari and Edge
- Automated HTML and JSON report generation on every run
- Live test dashboard with run history, pass rates and trend charts hosted on GitHub Pages
- Auto-cleanup of old reports to keep the repository lean
- Fully automated CI/CD via GitHub Actions — no external tools or paid services required

---

## 🛠 Tech Stack

| Tool | Purpose |
|---|---|
| [Playwright](https://playwright.dev) | Test framework |
| [GitHub Actions](https://github.com/features/actions) | CI/CD pipeline |
| [GitHub Pages](https://pages.github.com) | Dashboard hosting |
| Node.js 22 | Runtime |

---

## 📁 Project Structure
```
playwright-demo-js/
├── .github/
│   ├── scripts/
│   │   ├── generate-dashboard.js         # Builds the live HTML dashboard
│   │   └── generate-dashboard-local.js   # Run dashboard locally with mock data
│   └── workflows/
│       ├── run-tests.yml                 # Runs Playwright tests on demand
│       └── publish-report.yml            # Publishes report to GitHub Pages
├── e2e/
│   └── example.spec.js                   # Test specs
├── playwright.config.js                  # Playwright configuration
├── package.json
└── README.md
```

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 22
- npm

### Installation
```bash
# Clone the repository
git clone https://github.com/jay-yeluru/playwright-demo-js.git
cd playwright-demo-js

# Install dependencies
npm install

# Install Playwright browsers
npx playwright install
```

---

## 🧪 Running Tests

### Run all tests
```bash
npm test
```

### Run by browser
```bash
npm run test:chrome
npm run test:firefox
npm run test:safari
npm run test:edge
```

### Run smoke tests only
```bash
npm run test:smoke
```

### View the HTML report
```bash
npm run show-report
```

### Generate dashboard locally
```bash
npm run dashboard:local
```

---

## ⚙️ CI/CD Pipeline

The pipeline is split into two workflows:

### `run-tests.yml`
Triggered manually via `workflow_dispatch`. Allows selecting the browser to run tests on.
```
Inputs:
  browser: chrome | firefox | safari | edge (default: chrome)
```

Steps:
1. Checkout repository
2. Setup Node.js 22
3. Install dependencies via `npm ci`
4. Install Playwright browsers
5. Run tests
6. Upload reports as artifacts

### `publish-report.yml`
Triggered automatically after `run-tests.yml` completes (pass or fail).

Steps:
1. Checkout `gh-pages` branch
2. Fetch the dashboard generator script
3. Download reports artifact
4. Regenerate dashboard with updated history
5. Commit and push to `gh-pages`

---

## 📊 Test Dashboard

The live dashboard is hosted at **https://jay-yeluru.github.io/playwright-demo-js/** and updates automatically after every CI run.

### Dashboard features

- **Stats cards** — Total runs, passed runs, failed runs and overall pass rate
- **Sparkline chart** — Pass rate trend across the last 20 runs
- **Latest run banner** — Quick summary of the most recent run with a direct report link
- **Run history table** — Full history with status, branch, browser, pass/fail counts, pass rate bar and link to the full Playwright HTML report
- **Auto-cleanup** — Keeps the latest 10 runs per branch (configurable via `KEEP_RUNS`)

### GitHub Pages setup

1. Create an orphan `gh-pages` branch:
```bash
git switch --orphan gh-pages
git commit --allow-empty -m "init: gh-pages"
git push origin gh-pages
git checkout develop
```

2. Go to **Settings → Pages → Source**, select `gh-pages` branch and `/ (root)`

3. Go to **Settings → Actions → General → Workflow permissions** and enable **Read and write permissions**

---

## 🔧 Configuration

### `playwright.config.js`

| Option | Value | Description |
|---|---|---|
| `testDir` | `./e2e` | Test files location |
| `outputDir` | `test-artifacts` | Screenshots, traces, videos |
| `timeout` | `30000ms` | Per-test timeout |
| `retries` | `2` (CI) / `0` (local) | Retry on failure |
| `workers` | `1` (CI) / auto (local) | Parallel workers |
| `reporter` (CI) | `html`, `json`, `github` | CI reporters |
| `reporter` (local) | `html`, `json`, `list` | Local reporters |

### Reports output
```
reports/
  index.html          ← Playwright HTML report
  test-results.json   ← JSON report (used by dashboard generator)
test-artifacts/       ← Screenshots, videos, traces
```

### Environment variables (dashboard script)

| Variable | Description | Default |
|---|---|---|
| `BRANCH` | Git branch name | required |
| `RUN_ID` | GitHub Actions run ID | required |
| `BROWSER` | Browser used for the run | required |
| `REPORT_PATH` | Path to the downloaded reports | required |
| `KEEP_RUNS` | Number of runs to keep per branch | `10` |

---

## 📄 License

ISC © [Jay Yeluru](https://github.com/jay-yeluru)
