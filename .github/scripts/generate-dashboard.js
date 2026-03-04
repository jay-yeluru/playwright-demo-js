// @ts-check
const fs = require("fs");
const path = require("path");

/** @typedef {{ ok: boolean, tests?: any[] }} Spec */
/** @typedef {{ specs: Spec[], suites?: Suite[] }} Suite */
/** @typedef {{ suites: Suite[] }} TestResults */
/** @typedef {{ date: string, branch: string, browser: string, passed: number, failed: number, flaky: number, total: number, duration: number, status: string, conclusion: string, reportUrl: string, runId: string }} RunEntry */
/** @typedef {{ title: string, errors: string[] }} FailureSummary */
/** @typedef {{ runId: string, branch: string, date: string, failures: FailureSummary[] }} FailureArchive */

// ── Environment ───────────────────────────────────────────────────────────────

const ENV = {
  BRANCH: /** @type {string} */ (process.env.BRANCH),
  RUN_ID: /** @type {string} */ (process.env.RUN_ID),
  BROWSER: /** @type {string} */ (process.env.BROWSER),
  CONCLUSION: /** @type {string} */ (process.env.CONCLUSION ?? "success"),
  REPORT_PATH: /** @type {string} */ (process.env.REPORT_PATH),
  KEEP_RUNS: parseInt(process.env.KEEP_RUNS ?? "10", 10),
  KEEP_FAILED_RUNS: parseInt(process.env.KEEP_FAILED_RUNS ?? "30", 10),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** @param {string} filePath @returns {any} */
const readJSON = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

/** @param {string} filePath @param {any} data */
const writeJSON = (filePath, data) =>
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));

// ── Parse test results ────────────────────────────────────────────────────────

/** @returns {Pick<RunEntry, 'passed' | 'failed' | 'flaky' | 'total' | 'status' | 'duration'> & { detectedBrowser: string }} */
function parseResults() {
  const results = /** @type {TestResults} */ (
    readJSON(`${ENV.REPORT_PATH}/test-results.json`)
  );
  const specs = flattenSpecs(results.suites);
  const passed = specs.filter(/** @param {Spec} s */(s) => s.ok).length;
  const failed = specs.filter(/** @param {Spec} s */(s) => !s.ok).length;
  const flaky = specs
    .flatMap(/** @param {Spec} s */(s) => (s.ok ? s.tests ?? [] : []))
    .filter((/** @type {any} */ t) => (t.results?.length ?? 0) > 1).length;
  const browsers = new Set();
  const duration = specs
    .flatMap(/** @param {Spec} s */(s) => s.tests ?? [])
    .reduce(
      (sum, /** @type {any} */ t) => {
        if (t.projectName) browsers.add(t.projectName);
        return sum + (t.results?.[0]?.duration ?? 0);
      },
      0,
    );

  // Map playwright project names to friendly browser names
  const browsersArr = Array.from(browsers).map(b => {
    b = String(b).toLowerCase();
    if (b.includes("chrom")) return "chrome";
    if (b.includes("webkit")) return "safari";
    return b; // firefox, edge, etc.
  });

  return {
    passed,
    failed,
    flaky,
    total: passed + failed,
    duration,
    status: failed === 0 ? "✅" : "❌",
    detectedBrowser: browsersArr.join(", ") || "unknown",
  };
}

// ── Helpers: recursive spec flattening ───────────────────────────────────────

/** @param {Suite[]} suites @returns {Spec[]} */
function flattenSpecs(suites) {
  return suites.flatMap((s) => [
    ...(s.specs ?? []),
    ...flattenSpecs(/** @type {any[]} */(s.suites ?? [])),
  ]);
}

// ── Update history ────────────────────────────────────────────────────────────

const HISTORY_FILE = "dashboard.json";
const MAX_HISTORY = ENV.KEEP_RUNS + ENV.KEEP_FAILED_RUNS;

/** @param {RunEntry} entry @returns {RunEntry[]} */
function updateHistory(entry) {
  /** @type {RunEntry[]} */
  const history = fs.existsSync(HISTORY_FILE) ? readJSON(HISTORY_FILE) : [];

  // Clean up legacy badly-recorded browser names from history
  history.forEach(r => {
    if (r.browser === "Run Tests") {
      r.browser = "chrome"; // fallback guess for legacy runs
    }
  });

  history.unshift(entry);
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);
  writeJSON(HISTORY_FILE, history);
  return history;
}

// ── Archive failure summary ───────────────────────────────────────────────────

/** @param {string} runPath @param {string} runId @param {string} branch */
function archiveFailureSummary(runPath, runId, branch) {
  const resultsFile = path.join(runPath, "test-results.json");
  if (!fs.existsSync(resultsFile)) return;

  const results = /** @type {TestResults} */ (readJSON(resultsFile));
  const failures = flattenSpecs(results.suites)
    .filter(/** @param {Spec} s */(s) => !s.ok)
    .map(
      /** @param {any} s */(s) => ({
        title: s.title,
        errors:
          s.tests?.flatMap(
            /** @param {any} t */(t) =>
              t.results?.flatMap(
                /** @param {any} r */(r) =>
                  r.errors?.map(/** @param {any} e */(e) => e.message) ?? [],
              ) ?? [],
          ) ?? [],
      }),
    );

  if (failures.length === 0) return;

  const archiveDir = "failure-archive";
  fs.mkdirSync(archiveDir, { recursive: true });

  writeJSON(path.join(archiveDir, `${runId}.json`), {
    runId,
    branch,
    date: new Date().toISOString(),
    failures,
  });

  console.log(`Archived failure summary for run: ${runId}`);
}

// ── Clean up old runs ─────────────────────────────────────────────────────────

/** @param {string} branch @param {number} keepPassing @param {number} keepFailing @param {RunEntry[]} history */
function cleanOldRuns(branch, keepPassing, keepFailing, history) {
  const branchDir = path.join("reports", branch);
  if (!fs.existsSync(branchDir)) return;

  // Seed from in-memory history (recent runs).
  const failedRunIds = new Set(
    history.filter((r) => r.failed > 0).map((r) => r.runId),
  );

  // IMPORTANT: history is capped at MAX_HISTORY entries, so older failing runs
  // may have scrolled out of dashboard.json. Supplement from failure-archive/,
  // which retains a file per failing run indefinitely until we prune it here.
  const archiveDir = "failure-archive";
  if (fs.existsSync(archiveDir)) {
    fs.readdirSync(archiveDir)
      .filter((f) => f.endsWith(".json"))
      .forEach((f) => failedRunIds.add(f.replace(/\.json$/, "")));
  }

  const runs = fs
    .readdirSync(branchDir)
    .filter((f) => fs.statSync(path.join(branchDir, f)).isDirectory())
    .sort((a, b) => b.localeCompare(a));

  const passingRuns = runs.filter((r) => !failedRunIds.has(r));
  const failingRuns = runs.filter((r) => failedRunIds.has(r));
  const runsToDelete = [
    ...passingRuns.slice(keepPassing),
    ...failingRuns.slice(keepFailing),
  ];

  if (runsToDelete.length === 0) {
    console.log(`Nothing to clean up for branch: ${branch}.`);
    return;
  }

  for (const run of runsToDelete) {
    const runPath = path.join(branchDir, run);
    const isFailing = failedRunIds.has(run);
    fs.rmSync(runPath, { recursive: true, force: true });

    // If the run had failures, remove its failure-archive entry too so the
    // archive stays in sync and doesn't accumulate ghost entries forever.
    if (isFailing) {
      const archiveFile = path.join(archiveDir, `${run}.json`);
      if (fs.existsSync(archiveFile)) {
        fs.rmSync(archiveFile);
        console.log(`Removed failure-archive entry: ${run}.json`);
      }
    }

    console.log(`Pruned ${isFailing ? "failing" : "passing"} run: ${runPath}`);
  }

  console.log(
    `Kept latest ${keepPassing} passing and ${keepFailing} failing runs for branch: ${branch}.`,
  );
}

// ── Render table row ──────────────────────────────────────────────────────────

/** @param {RunEntry} r @param {number} i @returns {string} */
function renderRow(r, i) {
  const passRate = r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
  const durationStr = r.duration ? `${(r.duration / 1000).toFixed(1)}s` : "—";
  const isCancelled = r.conclusion === "cancelled";
  const browserIcon =
    { chrome: "🌐", firefox: "🦊", safari: "🧭", edge: "🔷" }[
    r.browser?.toLowerCase()
    ] ?? "🌐";
  const badgeClass = isCancelled
    ? "badge-cancelled"
    : r.failed > 0
      ? "badge-fail"
      : "badge-pass";
  const badgeText = isCancelled ? "SKIP" : r.failed > 0 ? "FAIL" : "PASS";
  const rowClass = isCancelled ? "cancelled" : r.failed > 0 ? "fail" : "pass";

  return `
    <tr class="${rowClass}" style="animation-delay:${i * 0.04}s">
      <td><span class="badge ${badgeClass}">${badgeText}</span></td>
      <td class="date-cell">${r.date}</td>
      <td><span class="branch-tag">${r.branch}</span></td>
      <td class="browser-cell">${browserIcon} ${r.browser}</td>
      <td class="pass-count">${r.passed}</td>
      <td class="fail-count ${r.failed === 0 ? "zero" : ""}">${r.failed}</td>
      <td class="flaky-count ${(r.flaky ?? 0) > 0 ? "has-flaky" : "zero"}">${(r.flaky ?? 0) > 0 ? `⚠️ ${r.flaky}` : "0"}</td>
      <td class="duration-cell">${durationStr}</td>
      <td>
        <div class="progress-wrap">
          <div class="progress-bar ${r.failed > 0 ? "progress-fail" : "progress-pass"}" style="width:${passRate}%"></div>
          <span class="progress-label">${passRate}%</span>
        </div>
      </td>
      <td>${isCancelled ? `<span class="cancelled-label">—</span>` : `<a class="view-btn" href="${r.reportUrl}" target="_blank">View <span>→</span></a>`}</td>
    </tr>`;
}

// ── Load failure archive ──────────────────────────────────────────────────────

/** @returns {FailureArchive[]} */
function loadFailureArchive() {
  const archiveDir = "failure-archive";
  if (!fs.existsSync(archiveDir)) return [];
  return fs
    .readdirSync(archiveDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => /** @type {FailureArchive} */(readJSON(path.join(archiveDir, f))))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 50);
}

// ── Build per-test history from archive ──────────────────────────────────────

/**
 * @typedef {{ title: string, totalFailures: number, runHistory: Array<{runId: string, branch: string, date: string, errors: string[]}> }} TestHistoryEntry
 */

/** @param {FailureArchive[]} archive @returns {TestHistoryEntry[]} */
function buildTestHistory(archive) {
  /** @type {Map<string, TestHistoryEntry>} */
  const map = new Map();

  for (const run of archive) {
    for (const failure of run.failures) {
      if (!map.has(failure.title)) {
        map.set(failure.title, {
          title: failure.title,
          totalFailures: 0,
          runHistory: [],
        });
      }
      const entry = /** @type {TestHistoryEntry} */ (map.get(failure.title));
      entry.totalFailures += 1;
      entry.runHistory.push({
        runId: run.runId,
        branch: run.branch,
        date: run.date,
        errors: failure.errors,
      });
    }
  }

  // Sort by most failures first
  return Array.from(map.values()).sort(
    (a, b) => b.totalFailures - a.totalFailures,
  );
}

// ── Render Detailed failure history section ───────────────────────────────

/** @param {FailureArchive[]} failureArchive @param {RunEntry[]} history @returns {string} */
function renderFailureHistory(failureArchive, history) {
  if (failureArchive.length === 0) return "";

  const testHistory = buildTestHistory(failureArchive);
  const totalFailedTests = testHistory.reduce((s, t) => s + t.totalFailures, 0);
  const branches = [...new Set(failureArchive.map((a) => a.branch))];

  // Build a lookup: runId -> reportUrl from history
  /** @type {Map<string, string>} */
  const runReportMap = new Map(history.map((r) => [r.runId, r.reportUrl]));

  // For each test, build a sparkline of last N runs (pass = grey pill, fail = red pill)
  // We need all known run IDs sorted newest first (from run history)
  const allRunIds = failureArchive.map((a) => a.runId); // already sorted newest-first

  /** @param {TestHistoryEntry} test @returns {string} */
  const renderTrendDots = (test) => {
    const failedRunIds = new Set(test.runHistory.map((r) => r.runId));
    // Show last 10 archive runs as trend dots
    return allRunIds
      .slice(0, 10)
      .map((runId) => {
        const isFail = failedRunIds.has(runId);
        return `<span class="trend-dot ${isFail ? "trend-fail" : "trend-pass"}" title="Run ${runId.substring(0, 8)}"></span>`;
      })
      .join("");
  };

  /** @param {TestHistoryEntry} test @returns {string} */
  const renderTestCard = (test) => {
    const safeId = test.title.replace(/[^a-zA-Z0-9]/g, "_").substring(0, 40);
    const failRate = Math.round(
      (test.totalFailures / failureArchive.length) * 100,
    );
    const lastFailed = test.runHistory[0];
    const lastFailedDate = lastFailed
      ? lastFailed.date.replace("T", " ").substring(0, 16) + " UTC"
      : "—";

    // Severity class
    const severityClass =
      failRate >= 70 ? "severity-critical" : failRate >= 40 ? "severity-high" : "severity-medium";
    const severityLabel =
      failRate >= 70 ? "Critical" : failRate >= 40 ? "High" : "Medium";

    return `
    <div class="th-card" id="thcard_${safeId}" data-branch="" data-title="${test.title.replace(/"/g, "&quot;")}">
      <div class="th-card-header" onclick="toggleTestHistory('${safeId}')">
        <div class="th-card-left">
          <span class="th-severity ${severityClass}">${severityLabel}</span>
          <div class="th-title">${test.title}</div>
        </div>
        <div class="th-card-right">
          <div class="th-trend">${renderTrendDots(test)}</div>
          <div class="th-stats">
            <span class="th-stat-fail" title="Total failures">✗ ${test.totalFailures}</span>
            <span class="th-stat-rate" title="Failure rate across archived runs">${failRate}%</span>
            <span class="th-stat-date" title="Last failed">${lastFailedDate}</span>
          </div>
          <span class="th-toggle-icon" id="thicon_${safeId}">▸</span>
        </div>
      </div>
      <div class="th-card-body" id="thbody_${safeId}" style="display:none">
        <div class="th-timeline-label">Run-by-run history (newest first)</div>
        <div class="th-timeline">
          ${test.runHistory
        .map((r, idx) => {
          const reportUrl = runReportMap.get(r.runId);
          const shortDate = r.date.replace("T", " ").substring(0, 16) + " UTC";
          const errPreview = r.errors[0]
            ? r.errors[0].toString().substring(0, 400)
            : "No error message captured.";
          return `
          <div class="th-run ${idx === 0 ? "th-run-latest" : ""}">
            <div class="th-run-meta">
              <span class="th-run-badge">FAIL</span>
              <span class="th-run-num">${idx === 0 ? "Latest" : `#${idx + 1}`}</span>
              <span class="branch-tag">${r.branch}</span>
              <span class="th-run-date">${shortDate}</span>
              ${reportUrl ? `<a class="view-btn view-btn-sm" href="${reportUrl}" target="_blank">Report →</a>` : ""}
            </div>
            <pre class="th-error">${errPreview}</pre>
          </div>`;
        })
        .join("")}
        </div>
      </div>
    </div>`;
  };

  const branchFilterOptions = branches
    .map((b) => `<option value="${b}">${b}</option>`)
    .join("");

  return `
  <div class="failure-section" id="failureHistorySection">
    <div class="fh-header">
      <div class="fh-header-left">
        <span class="fh-icon">🔴</span>
        <div>
          <div class="fh-title">Failure History</div>
          <div class="fh-subtitle">Per-test breakdown across the last ${failureArchive.length} failed run${failureArchive.length !== 1 ? "s" : ""}</div>
        </div>
      </div>
      <div class="fh-header-right">
        <div class="fh-summary-chips">
          <span class="fh-chip fh-chip-tests"><span class="fh-chip-val">${testHistory.length}</span><span class="fh-chip-lbl">Unique Failures</span></span>
          <span class="fh-chip fh-chip-runs"><span class="fh-chip-val">${failureArchive.length}</span><span class="fh-chip-lbl">Failed Runs</span></span>
          <span class="fh-chip fh-chip-total"><span class="fh-chip-val">${totalFailedTests}</span><span class="fh-chip-lbl">Total Failures</span></span>
        </div>
      </div>
    </div>

    <div class="fh-controls">
      <div class="fh-search-wrap">
        <span class="fh-search-icon">🔍</span>
        <input class="fh-search" id="thSearch" type="text" placeholder="Search test name…" oninput="filterTestHistory()" />
      </div>
      <select class="filter-select" id="thBranchFilter" onchange="filterTestHistory()">
        <option value="all">All branches</option>
        ${branchFilterOptions}
      </select>
      <select class="filter-select" id="thSortFilter" onchange="filterTestHistory()">
        <option value="failures">Sort: Most failures</option>
        <option value="rate">Sort: Failure rate</option>
        <option value="recent">Sort: Most recent</option>
      </select>
      <span class="run-count" id="thCount">${testHistory.length} tests</span>
    </div>

    <div class="fh-body" id="thList">
      ${testHistory.map(renderTestCard).join("")}
    </div>
  </div>`;
}

// ── Generate dashboard HTML ───────────────────────────────────────────────────

/** @param {RunEntry[]} history @param {FailureArchive[]} failureArchive */
function generateDashboard(history, failureArchive) {
  const totalRuns = history.length;
  const passedRuns = history.filter(
    (r) => r.failed === 0 && r.conclusion !== "cancelled",
  ).length;
  const failedRuns = history.filter((r) => r.failed > 0).length;
  const totalFlaky = history.reduce((sum, r) => sum + (r.flaky ?? 0), 0);
  const overallRate =
    totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0;
  const latestRun = history[0];
  const branches = [...new Set(history.map((r) => r.branch))];
  const browsers = [...new Set(history.map((r) => r.browser).filter(Boolean))];

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

  const branchOptions = branches
    .map((b) => `<option value="${b}">${b}</option>`)
    .join("");
  const browserOptions = browsers
    .map((b) => `<option value="${b}">${b}</option>`)
    .join("");

  const failureHistoryHTML = renderFailureHistory(failureArchive, history);

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
      --flaky: #f59e0b; --cancelled: #64748b;
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
    .container { position: relative; z-index: 1; max-width: 1280px; margin: 0 auto; padding: 2.5rem 2rem; }
    header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 2.5rem; flex-wrap: wrap; gap: 1rem; }
    .logo { display: flex; align-items: center; gap: 0.75rem; }
    .logo-icon { width: 44px; height: 44px; background: linear-gradient(135deg, var(--accent), var(--accent2)); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.4rem; animation: pulse 3s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { box-shadow: 0 0 20px rgba(0,229,255,0.3); } 50% { box-shadow: 0 0 35px rgba(0,229,255,0.6); } }
    .logo-text h1 { font-size: 1.4rem; font-weight: 800; letter-spacing: -0.02em; background: linear-gradient(90deg, #fff, var(--accent)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .logo-text p { font-size: 0.75rem; color: var(--muted); font-family: var(--font-mono); margin-top: 2px; }
    .header-meta { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); text-align: right; }
    .live-dot { display: inline-block; width: 7px; height: 7px; background: var(--pass); border-radius: 50%; margin-right: 5px; animation: blink 1.5s ease-in-out infinite; }
    @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1.25rem 1.5rem; position: relative; overflow: hidden; animation: slideUp 0.5s ease both; }
    .stat-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; }
    .stat-card.card-total::before  { background: var(--accent); }
    .stat-card.card-pass::before   { background: var(--pass); }
    .stat-card.card-fail::before   { background: var(--fail); }
    .stat-card.card-rate::before   { background: linear-gradient(90deg, var(--pass), var(--accent)); }
    .stat-card.card-flaky::before  { background: var(--flaky); }
    .stat-card:nth-child(1) { animation-delay: 0.05s; }
    .stat-card:nth-child(2) { animation-delay: 0.10s; }
    .stat-card:nth-child(3) { animation-delay: 0.15s; }
    .stat-card:nth-child(4) { animation-delay: 0.20s; }
    .stat-card:nth-child(5) { animation-delay: 0.25s; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
    .stat-label { font-size: 0.7rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.5rem; }
    .stat-value { font-size: 2.2rem; font-weight: 800; line-height: 1; letter-spacing: -0.03em; }
    .card-total .stat-value  { color: var(--accent); }
    .card-pass  .stat-value  { color: var(--pass); }
    .card-fail  .stat-value  { color: ${failedRuns > 0 ? "var(--fail)" : "var(--muted)"}; }
    .card-rate  .stat-value  { color: var(--text); }
    .card-flaky .stat-value  { color: var(--flaky); }
    .stat-sub { font-size: 0.72rem; color: var(--muted); margin-top: 0.4rem; font-family: var(--font-mono); display: flex; align-items: center; gap: 8px; }
    .sparkline polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

    .latest-banner { background: var(--surface); border: 1px solid var(--border); border-left: 3px solid ${latestRun?.failed === 0 ? "var(--pass)" : "var(--fail)"}; border-radius: 10px; padding: 1rem 1.5rem; margin-bottom: 2rem; display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; animation: slideUp 0.4s 0.25s ease both; }
    .latest-label { font-size: 0.65rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
    .latest-info { display: flex; align-items: center; gap: 1.5rem; flex-wrap: wrap; flex: 1; }
    .latest-stat { font-family: var(--font-mono); font-size: 0.8rem; color: var(--text); }
    .latest-stat strong { color: var(--accent); }

    .table-wrap { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; overflow: hidden; animation: slideUp 0.5s 0.3s ease both; }
    .table-header { display: flex; align-items: center; justify-content: space-between; padding: 1rem 1.5rem; border-bottom: 1px solid var(--border); gap: 1rem; flex-wrap: wrap; }
    .table-title { font-size: 0.8rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
    .table-controls { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .run-count { font-size: 0.72rem; font-family: var(--font-mono); color: var(--muted); background: var(--surface2); padding: 2px 10px; border-radius: 20px; border: 1px solid var(--border); }
    .filter-select { font-family: var(--font-mono); font-size: 0.75rem; background: var(--surface2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; cursor: pointer; outline: none; }
    .filter-select:focus { border-color: var(--accent); }

    table { width: 100%; border-collapse: collapse; }
    thead th { padding: 0.65rem 1rem; text-align: left; font-size: 0.68rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; background: var(--surface2); border-bottom: 1px solid var(--border); font-weight: 600; }
    tbody tr { border-bottom: 1px solid var(--border); transition: background 0.15s ease; animation: fadeIn 0.4s ease both; opacity: 0; }
    @keyframes fadeIn { from { opacity: 0; transform: translateX(-6px); } to { opacity: 1; transform: translateX(0); } }
    tbody tr:last-child { border-bottom: none; }
    tbody tr.pass:hover      { background: rgba(16,185,129,0.05); }
    tbody tr.fail:hover      { background: rgba(244,63,94,0.05); }
    tbody tr.cancelled:hover { background: rgba(100,116,139,0.05); }
    td { padding: 0.8rem 1rem; font-size: 0.82rem; vertical-align: middle; }

    .badge { display: inline-block; padding: 2px 9px; border-radius: 4px; font-size: 0.65rem; font-family: var(--font-mono); font-weight: 600; letter-spacing: 0.05em; }
    .badge-pass      { background: rgba(16,185,129,0.15); color: var(--pass);       border: 1px solid rgba(16,185,129,0.3); }
    .badge-fail      { background: rgba(244,63,94,0.15);  color: var(--fail);       border: 1px solid rgba(244,63,94,0.3); }
    .badge-cancelled { background: rgba(100,116,139,0.15); color: var(--cancelled); border: 1px solid rgba(100,116,139,0.3); }

    .date-cell     { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); }
    .duration-cell { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); }
    .branch-tag    { font-family: var(--font-mono); font-size: 0.75rem; background: var(--surface2); border: 1px solid var(--border); padding: 2px 8px; border-radius: 4px; color: var(--accent); }
    .browser-cell  { font-family: var(--font-mono); font-size: 0.82rem; }
    .pass-count    { color: var(--pass);  font-family: var(--font-mono); font-weight: 600; }
    .fail-count    { font-family: var(--font-mono); font-weight: 600; color: var(--fail); }
    .fail-count.zero { color: var(--muted); }
    .flaky-count   { font-family: var(--font-mono); font-weight: 600; }
    .flaky-count.has-flaky { color: var(--flaky); }
    .flaky-count.zero { color: var(--muted); }
    .cancelled-label { color: var(--muted); font-family: var(--font-mono); }

    .progress-wrap  { position: relative; background: var(--surface2); border-radius: 4px; height: 20px; width: 100px; overflow: hidden; border: 1px solid var(--border); }
    .progress-bar   { height: 100%; border-radius: 4px; }
    .progress-pass  { background: linear-gradient(90deg, var(--pass), #34d399); }
    .progress-fail  { background: linear-gradient(90deg, var(--fail), #fb7185); }
    .progress-label { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 0.65rem; font-family: var(--font-mono); font-weight: 600; color: white; text-shadow: 0 1px 2px rgba(0,0,0,0.5); }

    .view-btn { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); text-decoration: none; font-size: 0.78rem; font-family: var(--font-mono); padding: 4px 10px; border: 1px solid rgba(0,229,255,0.2); border-radius: 6px; transition: all 0.2s ease; background: rgba(0,229,255,0.05); }
    .view-btn:hover { background: rgba(0,229,255,0.12); border-color: var(--accent); box-shadow: 0 0 12px rgba(0,229,255,0.2); transform: translateX(2px); }
    .view-btn-sm { font-size: 0.68rem; padding: 2px 8px; }

    footer { text-align: center; padding: 2rem 0 1rem; font-family: var(--font-mono); font-size: 0.7rem; color: var(--muted); }

    /* ── Failure History (Detailed Failure Summary style) ──────────────────────────────── */
    .failure-section {
      background: var(--surface);
      border: 1px solid rgba(244,63,94,0.2);
      border-radius: 14px;
      overflow: hidden;
      margin-top: 1.5rem;
      animation: slideUp 0.5s 0.35s ease both;
    }

    /* header bar */
    .fh-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 1.25rem 1.5rem;
      background: linear-gradient(90deg, rgba(244,63,94,0.08), transparent);
      border-bottom: 1px solid rgba(244,63,94,0.15);
      flex-wrap: wrap; gap: 1rem;
    }
    .fh-header-left { display: flex; align-items: center; gap: 0.85rem; }
    .fh-icon { font-size: 1.4rem; }
    .fh-title { font-size: 1rem; font-weight: 700; color: var(--text); letter-spacing: -0.01em; }
    .fh-subtitle { font-size: 0.7rem; font-family: var(--font-mono); color: var(--muted); margin-top: 2px; }
    .fh-header-right { display: flex; align-items: center; gap: 0.75rem; }
    .fh-summary-chips { display: flex; gap: 0.6rem; flex-wrap: wrap; }
    .fh-chip { display: flex; flex-direction: column; align-items: center; padding: 0.4rem 0.85rem; border-radius: 8px; border: 1px solid var(--border); background: var(--surface2); min-width: 72px; }
    .fh-chip-tests { border-color: rgba(244,63,94,0.3); }
    .fh-chip-runs  { border-color: rgba(124,58,237,0.3); }
    .fh-chip-total { border-color: rgba(245,158,11,0.3); }
    .fh-chip-val   { font-size: 1.15rem; font-weight: 800; line-height: 1; }
    .fh-chip-tests .fh-chip-val { color: var(--fail); }
    .fh-chip-runs  .fh-chip-val { color: var(--accent2); }
    .fh-chip-total .fh-chip-val { color: var(--flaky); }
    .fh-chip-lbl   { font-size: 0.6rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 2px; }

    /* controls */
    .fh-controls {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.85rem 1.5rem;
      border-bottom: 1px solid var(--border);
      background: var(--surface2);
      flex-wrap: wrap;
    }
    .fh-search-wrap { position: relative; flex: 1; min-width: 200px; }
    .fh-search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 0.8rem; pointer-events: none; }
    .fh-search {
      width: 100%; padding: 5px 10px 5px 30px;
      background: var(--surface); color: var(--text);
      border: 1px solid var(--border); border-radius: 6px;
      font-family: var(--font-mono); font-size: 0.78rem; outline: none;
      transition: border-color 0.15s ease;
    }
    .fh-search:focus { border-color: var(--accent); }
    .fh-search::placeholder { color: var(--muted); }

    /* body list */
    .fh-body { padding: 1rem 1.5rem; display: flex; flex-direction: column; gap: 0.6rem; }

    /* test card */
    .th-card {
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .th-card:hover { border-color: rgba(244,63,94,0.35); box-shadow: 0 2px 16px rgba(244,63,94,0.08); }

    .th-card-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 0.7rem 1rem; cursor: pointer; background: var(--surface2);
      gap: 0.75rem; flex-wrap: wrap;
      transition: background 0.15s ease;
    }
    .th-card-header:hover { background: rgba(244,63,94,0.06); }

    .th-card-left  { display: flex; align-items: center; gap: 0.65rem; flex: 1; min-width: 0; }
    .th-card-right { display: flex; align-items: center; gap: 0.85rem; flex-shrink: 0; flex-wrap: wrap; }

    .th-title { font-size: 0.85rem; font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 500px; }

    /* severity badge */
    .th-severity {
      font-size: 0.6rem; font-family: var(--font-mono); font-weight: 700;
      padding: 2px 7px; border-radius: 4px; letter-spacing: 0.06em;
      flex-shrink: 0; text-transform: uppercase;
    }
    .severity-critical { background: rgba(244,63,94,0.2);  color: #fb7185; border: 1px solid rgba(244,63,94,0.4); }
    .severity-high     { background: rgba(245,158,11,0.15); color: #fbbf24; border: 1px solid rgba(245,158,11,0.35); }
    .severity-medium   { background: rgba(124,58,237,0.15); color: #a78bfa; border: 1px solid rgba(124,58,237,0.3); }

    /* trend dots */
    .th-trend { display: flex; align-items: center; gap: 3px; }
    .trend-dot {
      width: 10px; height: 10px; border-radius: 3px;
      flex-shrink: 0;
    }
    .trend-fail { background: var(--fail); box-shadow: 0 0 4px rgba(244,63,94,0.5); }
    .trend-pass { background: #1e3a2b; border: 1px solid #2d5a40; }

    /* stats */
    .th-stats { display: flex; align-items: center; gap: 0.7rem; }
    .th-stat-fail { font-family: var(--font-mono); font-size: 0.75rem; font-weight: 700; color: var(--fail); }
    .th-stat-rate { font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted); background: var(--surface); border: 1px solid var(--border); padding: 1px 7px; border-radius: 10px; }
    .th-stat-date { font-family: var(--font-mono); font-size: 0.68rem; color: var(--muted); }
    .th-toggle-icon { font-size: 0.85rem; color: var(--muted); transition: transform 0.2s ease; flex-shrink: 0; }

    /* expanded body */
    .th-card-body { border-top: 1px solid var(--border); }
    .th-timeline-label {
      font-size: 0.65rem; font-family: var(--font-mono); color: var(--muted);
      text-transform: uppercase; letter-spacing: 0.08em;
      padding: 0.7rem 1rem 0.3rem;
    }
    .th-timeline { display: flex; flex-direction: column; gap: 0; }

    /* individual run inside expanded card */
    .th-run {
      padding: 0.75rem 1rem;
      border-top: 1px solid var(--border);
      transition: background 0.1s ease;
    }
    .th-run:first-child { border-top: none; }
    .th-run:hover { background: rgba(244,63,94,0.04); }
    .th-run-latest { background: rgba(244,63,94,0.04); }

    .th-run-meta {
      display: flex; align-items: center; gap: 0.6rem;
      margin-bottom: 0.45rem; flex-wrap: wrap;
    }
    .th-run-badge {
      font-size: 0.6rem; font-family: var(--font-mono); font-weight: 700;
      padding: 1px 6px; border-radius: 3px; letter-spacing: 0.05em;
      background: rgba(244,63,94,0.15); color: var(--fail); border: 1px solid rgba(244,63,94,0.3);
    }
    .th-run-num  { font-family: var(--font-mono); font-size: 0.72rem; color: var(--muted); min-width: 40px; }
    .th-run-date { font-family: var(--font-mono); font-size: 0.7rem; color: var(--muted); margin-left: auto; }

    .th-error {
      font-family: var(--font-mono); font-size: 0.7rem; color: #fca5a5;
      background: rgba(244,63,94,0.06); border: 1px solid rgba(244,63,94,0.15);
      border-radius: 6px; padding: 0.6rem 0.85rem;
      white-space: pre-wrap; word-break: break-all;
      max-height: 140px; overflow-y: auto;
      line-height: 1.5;
    }

    /* empty state */
    .th-empty { text-align: center; padding: 2.5rem 1rem; font-family: var(--font-mono); font-size: 0.78rem; color: var(--muted); }

    @media (max-width: 768px) {
      .stats-grid { grid-template-columns: repeat(2, 1fr); }
      td:nth-child(2), th:nth-child(2),
      td:nth-child(8), th:nth-child(8) { display: none; }
      .progress-wrap { width: 60px; }
      .fh-controls { flex-direction: column; align-items: stretch; }
      .th-title { max-width: 200px; }
      .th-stat-date { display: none; }
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
      <div class="stat-card card-flaky">
        <div class="stat-label">Flaky Tests</div>
        <div class="stat-value">${totalFlaky}</div>
        <div class="stat-sub">total retried passes</div>
      </div>
    </div>

    ${latestRun
      ? `
    <div class="latest-banner">
      <div class="latest-label">Latest</div>
      <div class="latest-info">
        <span class="latest-stat"><strong>${latestRun.branch}</strong></span>
        <span class="latest-stat">${{ chrome: "🌐", firefox: "🦊", safari: "🧭", edge: "🔷" }[latestRun.browser?.toLowerCase()] ?? "🌐"} ${latestRun.browser}</span>
        <span class="latest-stat" style="color:var(--pass)">✓ ${latestRun.passed} passed</span>
        ${latestRun.failed > 0 ? `<span class="latest-stat" style="color:var(--fail)">✗ ${latestRun.failed} failed</span>` : ""}
        ${(latestRun.flaky ?? 0) > 0 ? `<span class="latest-stat" style="color:var(--flaky)">⚠️ ${latestRun.flaky} flaky</span>` : ""}
        <span class="latest-stat">⏱ ${latestRun.duration ? (latestRun.duration / 1000).toFixed(1) + "s" : "—"}</span>
        <span class="latest-stat">${latestRun.date}</span>
      </div>
      <a class="view-btn" href="${latestRun.reportUrl}" target="_blank">Latest Report <span>→</span></a>
    </div>`
      : ""
    }

    <div class="table-wrap">
      <div class="table-header">
        <span class="table-title">Run History</span>
        <div class="table-controls">
          <select class="filter-select" id="branchFilter" onchange="applyFilters()">
            <option value="all">All branches</option>
            ${branchOptions}
          </select>
          <select class="filter-select" id="browserFilter" onchange="applyFilters()">
            <option value="all">All browsers</option>
            ${browserOptions}
          </select>
          <span class="run-count" id="runCount">${totalRuns} runs</span>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Status</th>
            <th>Date</th>
            <th>Branch</th>
            <th>Browser</th>
            <th>Passed</th>
            <th>Failed</th>
            <th>Flaky</th>
            <th>Duration</th>
            <th>Rate</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody id="runTable">${history.map(renderRow).join("")}</tbody>
      </table>
    </div>

    ${failureHistoryHTML}

    <footer>Generated by playwright-demo-js · ${new Date().toISOString().replace("T", " ").substring(0, 19)} UTC</footer>
  </div>

  <script>
    // ── Run history table filters ────────────────────────────────────────────
    function applyFilters() {
      const branch  = document.getElementById('branchFilter').value;
      const browser = document.getElementById('browserFilter').value;
      const rows    = document.querySelectorAll('#runTable tr');
      let visible   = 0;

      rows.forEach(row => {
        const branchCell  = row.querySelector('.branch-tag')?.textContent?.trim();
        const browserCell = row.querySelector('.browser-cell')?.textContent?.trim().toLowerCase();
        const branchMatch  = branch  === 'all' || branchCell  === branch;
        const browserMatch = browser === 'all' || browserCell?.includes(browser.toLowerCase());
        const show = branchMatch && browserMatch;
        row.style.display = show ? '' : 'none';
        if (show) visible++;
      });

      document.getElementById('runCount').textContent = visible + ' runs';
    }

    // ── Failure history: toggle individual test card ────────────────────────
    function toggleTestHistory(id) {
      const body = document.getElementById('thbody_' + id);
      const icon = document.getElementById('thicon_' + id);
      if (!body) return;
      const open = body.style.display !== 'none';
      body.style.display = open ? 'none' : '';
      if (icon) icon.textContent = open ? '▸' : '▾';
    }

    // ── Failure history: search + branch filter + sort ──────────────────────
    function filterTestHistory() {
      const query  = (document.getElementById('thSearch')?.value ?? '').toLowerCase().trim();
      const branch = document.getElementById('thBranchFilter')?.value ?? 'all';
      const sort   = document.getElementById('thSortFilter')?.value ?? 'failures';
      const list   = document.getElementById('thList');
      if (!list) return;

      const cards = Array.from(list.querySelectorAll('.th-card'));
      let visible = 0;

      cards.forEach(card => {
        const title  = (card.getAttribute('data-title') ?? '').toLowerCase();
        const matchQ = !query  || title.includes(query);

        // branch match: check if any run entry inside the card has this branch
        let matchB = branch === 'all';
        if (!matchB) {
          const tags = card.querySelectorAll('.branch-tag');
          tags.forEach(t => { if (t.textContent?.trim() === branch) matchB = true; });
        }

        const show = matchQ && matchB;
        card.style.display = show ? '' : 'none';
        if (show) visible++;
      });

      // Sorting (re-order DOM nodes)
      const visibleCards = cards.filter(c => c.style.display !== 'none');
      const sorted = visibleCards.slice().sort((a, b) => {
        if (sort === 'failures') {
          // cards already rendered in failure-count order; keep stable by reading stat text
          const fa = parseInt(a.querySelector('.th-stat-fail')?.textContent?.replace(/[^0-9]/g,'') ?? '0', 10);
          const fb = parseInt(b.querySelector('.th-stat-fail')?.textContent?.replace(/[^0-9]/g,'') ?? '0', 10);
          return fb - fa;
        } else if (sort === 'rate') {
          const ra = parseInt(a.querySelector('.th-stat-rate')?.textContent?.replace(/[^0-9]/g,'') ?? '0', 10);
          const rb = parseInt(b.querySelector('.th-stat-rate')?.textContent?.replace(/[^0-9]/g,'') ?? '0', 10);
          return rb - ra;
        } else if (sort === 'recent') {
          const da = a.querySelector('.th-run-date')?.textContent ?? '';
          const db = b.querySelector('.th-run-date')?.textContent ?? '';
          return db.localeCompare(da);
        }
        return 0;
      });

      sorted.forEach(card => list.appendChild(card));

      const countEl = document.getElementById('thCount');
      if (countEl) countEl.textContent = visible + ' test' + (visible !== 1 ? 's' : '');

      if (visible === 0 && !list.querySelector('.th-empty')) {
        const empty = document.createElement('div');
        empty.className = 'th-empty';
        empty.textContent = 'No tests match your filters.';
        list.appendChild(empty);
      } else {
        list.querySelector('.th-empty')?.remove();
      }
    }
  </script>
</body>
</html>`;

  fs.writeFileSync("index.html", html);
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main() {
  // Validate required environment variables up-front for a clear error message.
  for (const key of /** @type {(keyof typeof ENV)[]} */ (["BRANCH", "RUN_ID", "REPORT_PATH"])) {
    if (!ENV[key]) throw new Error(`Missing required environment variable: ${key}`);
  }

  const {
    BRANCH,
    RUN_ID,
    CONCLUSION,
    REPORT_PATH,
    KEEP_RUNS,
    KEEP_FAILED_RUNS,
  } = ENV;
  const { passed, failed, flaky, total, duration, status, detectedBrowser } = parseResults();

  // Use passed BROWSER env var, fallback to detected from JSON
  let BROWSER = ENV.BROWSER || detectedBrowser;
  if (BROWSER === "Run Tests") BROWSER = detectedBrowser || "chrome";

  /** @type {RunEntry} */
  const entry = {
    date: new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC",
    branch: BRANCH,
    browser: BROWSER,
    passed,
    failed,
    flaky,
    total,
    duration,
    status,
    conclusion: CONCLUSION,
    reportUrl: `reports/${BRANCH}/${RUN_ID}/index.html`,
    runId: RUN_ID,
  };

  const history = updateHistory(entry);

  if (failed > 0) {
    archiveFailureSummary(REPORT_PATH, RUN_ID, BRANCH);
  }

  cleanOldRuns(BRANCH, KEEP_RUNS, KEEP_FAILED_RUNS, history);
  const failureArchive = loadFailureArchive();
  generateDashboard(history, failureArchive);

  console.log(`Dashboard regenerated with ${history.length} runs, ${failureArchive.length} failure archive entries.`);
}

main();
