// @ts-check
const fs = require("fs");
const path = require("path");

/** @typedef {{ ok: boolean }} Spec */
/** @typedef {{ specs: Spec[] }} Suite */
/** @typedef {{ suites: Suite[] }} TestResults */
/** @typedef {{ date: string, branch: string, browser: string, passed: number, failed: number, total: number, status: string, reportUrl: string, runId: string }} RunEntry */

// ── Environment ───────────────────────────────────────────────────────────────

const ENV = {
  BRANCH: /** @type {string} */ (process.env.BRANCH),
  RUN_ID: /** @type {string} */ (process.env.RUN_ID),
  BROWSER: /** @type {string} */ (process.env.BROWSER),
  REPORT_PATH: /** @type {string} */ (process.env.REPORT_PATH),
  KEEP_RUNS: parseInt(process.env.KEEP_RUNS ?? "10", 10),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** @param {string} filePath @returns {any} */
const readJSON = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

/** @param {string} filePath @param {any} data */
const writeJSON = (filePath, data) =>
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

// ── Parse test results ────────────────────────────────────────────────────────

/** @returns {Pick<RunEntry, 'passed' | 'failed' | 'total' | 'status'>} */
function parseResults() {
  const results = /** @type {TestResults} */ (
    readJSON(`${ENV.REPORT_PATH}/test-results.json`)
  );
  const specs = results.suites.flatMap(/** @param {Suite} s */ (s) => s.specs);
  const passed = specs.filter(/** @param {Spec} s */ (s) => s.ok).length;
  const failed = specs.filter(/** @param {Spec} s */ (s) => !s.ok).length;
  return {
    passed,
    failed,
    total: passed + failed,
    status: failed === 0 ? "✅" : "❌",
  };
}

// ── Update history ────────────────────────────────────────────────────────────

const HISTORY_FILE = "dashboard.json";
const MAX_HISTORY = 100;

/** @param {RunEntry} entry @returns {RunEntry[]} */
function updateHistory(entry) {
  /** @type {RunEntry[]} */
  const history = fs.existsSync(HISTORY_FILE) ? readJSON(HISTORY_FILE) : [];
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  writeJSON(HISTORY_FILE, history);
  return history;
}

// ── Clean up old runs ─────────────────────────────────────────────────────────

/** @param {string} branch @param {number} keepRuns */
function cleanOldRuns(branch, keepRuns) {
  const branchDir = path.join("reports", branch);
  if (!fs.existsSync(branchDir)) return;

  const oldRuns = fs
    .readdirSync(branchDir)
    .filter((f) => fs.statSync(path.join(branchDir, f)).isDirectory())
    .sort((a, b) => b.localeCompare(a))
    .slice(keepRuns);

  if (oldRuns.length === 0) {
    console.log(
      `Nothing to clean up (≤ ${keepRuns} runs for branch: ${branch}).`,
    );
    return;
  }

  for (const run of oldRuns) {
    const runPath = path.join(branchDir, run);
    fs.rmSync(runPath, { recursive: true, force: true });
    console.log(`Removed old run: ${runPath}`);
  }
  console.log(`Kept latest ${keepRuns} runs for branch: ${branch}.`);
}

// ── Render table row ──────────────────────────────────────────────────────────

/** @param {RunEntry} r @param {number} i @returns {string} */
function renderRow(r, i) {
  const passRate = r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
  const browserIcon =
    { chrome: "🌐", firefox: "🦊", safari: "🧭", edge: "🔷" }[
      r.browser?.toLowerCase()
    ] ?? "🌐";
  return `
    <tr class="${r.failed > 0 ? "fail" : "pass"}" style="animation-delay:${i * 0.04}s">
      <td><span class="badge ${r.failed > 0 ? "badge-fail" : "badge-pass"}">${r.failed > 0 ? "FAIL" : "PASS"}</span></td>
      <td class="date-cell">${r.date}</td>
      <td><span class="branch-tag">${r.branch}</span></td>
      <td>${browserIcon} ${r.browser}</td>
      <td class="pass-count">${r.passed}</td>
      <td class="fail-count ${r.failed === 0 ? "zero" : ""}">${r.failed}</td>
      <td>
        <div class="progress-wrap">
          <div class="progress-bar ${r.failed > 0 ? "progress-fail" : "progress-pass"}" style="width:${passRate}%"></div>
          <span class="progress-label">${passRate}%</span>
        </div>
      </td>
      <td><a class="view-btn" href="${r.reportUrl}" target="_blank">View <span>→</span></a></td>
    </tr>`;
}

// ── Generate dashboard HTML ───────────────────────────────────────────────────

/** @param {RunEntry[]} history */
function generateDashboard(history) {
  const totalRuns = history.length;
  const passedRuns = history.filter((r) => r.failed === 0).length;
  const failedRuns = totalRuns - passedRuns;
  const overallRate =
    totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0;
  const latestRun = history[0];

  const sparkData = history
    .slice(0, 20)
    .reverse()
    .map((r) => (r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0));
  const sparkW = 120,
    sparkH = 32;
  const sparkPoints = sparkData
    .map((v, i) => {
      const x = (i / Math.max(sparkData.length - 1, 1)) * sparkW;
      const y = sparkH - (v / 100) * sparkH;
      return `${x},${y}`;
    })
    .join(" ");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Playwright Test Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Syne:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0a0e1a; --surface: #111827; --surface2: #1a2235; --border: #1e2d45;
      --accent: #00e5ff; --accent2: #7c3aed; --pass: #10b981; --fail: #f43f5e;
      --text: #e2e8f0; --muted: #64748b;
      --font-display: 'Syne', sans-serif; --font-mono: 'JetBrains Mono', monospace;
    }
    body { font-family: var(--font-display); background: var(--bg); color: var(--text); min-height: 100vh; overflow-x: hidden; }
    body::before {
      content: ''; position: fixed; inset: 0;
      background-image: linear-gradient(rgba(0,229,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,229,255,0.03) 1px, transparent 1px);
      background-size: 40px 40px; animation: gridPan 20s linear infinite; pointer-events: none; z-index: 0;
    }
    @keyframes gridPan { 0% { background-position: 0 0; } 100% { background-position: 40px 40px; } }
    .container { position: relative; z-index: 1; max-width: 1200px; margin: 0 auto; padding: 2.5rem 2rem; }
    header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 2.5rem; flex-wrap: wrap; gap: 1rem; }
    .logo { display: flex; align-items: center; gap: 0.75rem; }
    .logo-icon {
      width: 44px; height: 44px; background: linear-gradient(135deg, var(--accent), var(--accent2));
      border-radius: 10px; display: flex; align-items: center; justify-content: center;
      font-size: 1.4rem; animation: pulse 3s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 20px rgba(0,229,255,0.3); }
      50%       { box-shadow: 0 0 35px rgba(0,229,255,0.6); }
    }
    .logo-text h1 {
      font-size: 1.4rem; font-weight: 800; letter-spacing: -0.02em;
      background: linear-gradient(90deg, #fff, var(--accent)); -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .logo-text p { font-size: 0.75rem; color: var(--muted); font-family: var(--font-mono); margin-top: 2px; }
    .header-meta { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); text-align: right; }
    .live-dot { display: inline-block; width: 7px; height: 7px; background: var(--pass); border-radius: 50%; margin-right: 5px; animation: blink 1.5s ease-in-out infinite; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem 1.5rem; position: relative; overflow: hidden; animation: slideUp 0.5s ease both; }
    .stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; }
    .stat-card.card-total::before { background: var(--accent); }
    .stat-card.card-pass::before  { background: var(--pass); }
    .stat-card.card-fail::before  { background: var(--fail); }
    .stat-card.card-rate::before  { background: linear-gradient(90deg, var(--pass), var(--accent)); }
    .stat-card:nth-child(1) { animation-delay: 0.05s; }
    .stat-card:nth-child(2) { animation-delay: 0.10s; }
    .stat-card:nth-child(3) { animation-delay: 0.15s; }
    .stat-card:nth-child(4) { animation-delay: 0.20s; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    .stat-label { font-size: 0.7rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.5rem; }
    .stat-value { font-size: 2.2rem; font-weight: 800; line-height: 1; letter-spacing: -0.03em; }
    .card-total .stat-value { color: var(--accent); }
    .card-pass  .stat-value { color: var(--pass); }
    .card-fail  .stat-value { color: ${failedRuns > 0 ? "var(--fail)" : "var(--muted)"}; }
    .card-rate  .stat-value { color: var(--text); }
    .stat-sub { font-size: 0.72rem; color: var(--muted); margin-top: 0.4rem; font-family: var(--font-mono); display: flex; align-items: center; gap: 8px; }
    .sparkline polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
    .latest-banner {
      background: var(--surface); border: 1px solid var(--border);
      border-left: 3px solid ${latestRun?.failed === 0 ? "var(--pass)" : "var(--fail)"};
      border-radius: 10px; padding: 1rem 1.5rem; margin-bottom: 2rem;
      display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
      animation: slideUp 0.4s 0.25s ease both;
    }
    .latest-label { font-size: 0.65rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
    .latest-info { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; flex: 1; }
    .latest-stat { font-family: var(--font-mono); font-size: 0.8rem; color: var(--text); }
    .latest-stat strong { color: var(--accent); }
    .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; animation: slideUp 0.5s 0.3s ease both; }
    .table-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); }
    .table-title { font-size: 0.8rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
    .run-count { font-size: 0.72rem; font-family: var(--font-mono); color: var(--muted); background: var(--surface2); padding: 2px 10px; border-radius: 20px; border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; }
    thead th { padding: 0.65rem 1rem; text-align: left; font-size: 0.68rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; background: var(--surface2); border-bottom: 1px solid var(--border); font-weight: 600; }
    tbody tr { border-bottom: 1px solid var(--border); transition: background 0.15s ease; animation: fadeIn 0.4s ease both; opacity: 0; }
    @keyframes fadeIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
    tbody tr:last-child { border-bottom: none; }
    tbody tr.pass:hover { background: rgba(16,185,129,0.05); }
    tbody tr.fail:hover { background: rgba(244,63,94,0.05); }
    td { padding: 0.8rem 1rem; font-size: 0.82rem; vertical-align: middle; }
    .badge { display: inline-block; padding: 2px 9px; border-radius: 4px; font-size: 0.65rem; font-family: var(--font-mono); font-weight: 600; letter-spacing: 0.05em; }
    .badge-pass { background: rgba(16,185,129,0.15); color: var(--pass); border: 1px solid rgba(16,185,129,0.3); }
    .badge-fail { background: rgba(244,63,94,0.15);  color: var(--fail); border: 1px solid rgba(244,63,94,0.3); }
    .date-cell { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); }
    .branch-tag { font-family: var(--font-mono); font-size: 0.75rem; background: var(--surface2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 4px; color: var(--accent); }
    .pass-count { color: var(--pass); font-family: var(--font-mono); font-weight: 600; }
    .fail-count { font-family: var(--font-mono); font-weight: 600; color: var(--fail); }
    .fail-count.zero { color: var(--muted); }
    .progress-wrap { position: relative; background: var(--surface2); border-radius: 4px; height: 20px; width: 100px; overflow: hidden; border: 1px solid var(--border); }
    .progress-bar { height: 100%; border-radius: 4px; }
    .progress-pass { background: linear-gradient(90deg, var(--pass), #34d399); }
    .progress-fail { background: linear-gradient(90deg, var(--fail), #fb7185); }
    .progress-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-family: var(--font-mono); font-weight: 600; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }
    .view-btn { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); text-decoration: none; font-size: 0.78rem; font-family: var(--font-mono); padding: 4px 10px; border: 1px solid rgba(0,229,255,0.2); border-radius: 6px; transition: all 0.2s ease; background: rgba(0,229,255,0.05); }
    .view-btn:hover { background: rgba(0,229,255,0.12); border-color: var(--accent); box-shadow: 0 0 12px rgba(0,229,255,0.2); transform: translateX(2px); }
    .view-btn span { transition: transform 0.2s ease; }
    .view-btn:hover span { transform: translateX(3px); }
    footer { text-align: center; padding: 2rem 0 1rem; font-family: var(--font-mono); font-size: 0.7rem; color: var(--muted); }
    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      td:nth-child(2), th:nth-child(2) { display: none; }
      .progress-wrap { width: 60px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="logo">
        <div class="logo-icon">🎭</div>
        <div class="logo-text">
          <h1>Playwright Dashboard</h1>
          <p>jay-yeluru / playwright-demo-js</p>
        </div>
      </div>
      <div class="header-meta">
        <div><span class="live-dot"></span>Auto-updated on every run</div>
        <div style="margin-top:4px">Last run: ${latestRun?.date ?? "—"}</div>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card card-total">
        <div class="stat-label">Total Runs</div>
        <div class="stat-value">${totalRuns}</div>
        <div class="stat-sub">all time
          <svg class="sparkline" width="${sparkW}" height="${sparkH}" viewBox="0 0 ${sparkW} ${sparkH}">
            <polyline points="${sparkPoints}" />
          </svg>
        </div>
      </div>
      <div class="stat-card card-pass">
        <div class="stat-label">Passed Runs</div>
        <div class="stat-value">${passedRuns}</div>
        <div class="stat-sub">all tests green</div>
      </div>
      <div class="stat-card card-fail">
        <div class="stat-label">Failed Runs</div>
        <div class="stat-value">${failedRuns}</div>
        <div class="stat-sub">had failures</div>
      </div>
      <div class="stat-card card-rate">
        <div class="stat-label">Pass Rate</div>
        <div class="stat-value">${overallRate}%</div>
        <div class="stat-sub">across all runs</div>
      </div>
    </div>

    ${
      latestRun
        ? `
    <div class="latest-banner">
      <div class="latest-label">Latest</div>
      <div class="latest-info">
        <span class="latest-stat"><strong>${latestRun.branch}</strong></span>
        <span class="latest-stat">${latestRun.browser}</span>
        <span class="latest-stat" style="color:var(--pass)">✓ ${latestRun.passed} passed</span>
        ${latestRun.failed > 0 ? `<span class="latest-stat" style="color:var(--fail)">✗ ${latestRun.failed} failed</span>` : ""}
        <span class="latest-stat">${latestRun.date}</span>
      </div>
      <a class="view-btn" href="${latestRun.reportUrl}" target="_blank">Latest Report <span>→</span></a>
    </div>`
        : ""
    }

    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">Run History</span>
        <span class="run-count">${totalRuns} runs</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Status</th><th>Date</th><th>Branch</th><th>Browser</th>
            <th>Passed</th><th>Failed</th><th>Rate</th><th>Report</th>
          </tr>
        </thead>
        <tbody>${history.map(renderRow).join("")}</tbody>
      </table>
    </div>

    <footer>Generated by playwright-demo-js · ${new Date().toISOString().replace("T", " ").substring(0, 19)} UTC</footer>
  </div>
</body>
</html>`;

  fs.writeFileSync("index.html", html);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  const { BRANCH, RUN_ID, BROWSER, REPORT_PATH, KEEP_RUNS } = ENV;
  const { passed, failed, total, status } = parseResults();

  /** @type {RunEntry} */
  const entry = {
    date: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
    branch: BRANCH,
    browser: BROWSER,
    passed,
    failed,
    total,
    status,
    reportUrl: `reports/${BRANCH}/${RUN_ID}/index.html`,
    runId: RUN_ID,
  };

  const history = updateHistory(entry);
  cleanOldRuns(BRANCH, KEEP_RUNS);
  generateDashboard(history);

  console.log(`Dashboard regenerated with ${history.length} runs.`);
}

main();
