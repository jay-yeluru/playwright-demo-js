// @ts-check
const fs = require("fs");
const path = require("path");

/** @typedef {{ ok: boolean, tests?: any[] }} Spec */
/** @typedef {{ specs: Spec[], suites?: Suite[] }} Suite */
/** @typedef {{ suites: Suite[] }} TestResults */
/** @typedef {{ date: string, branch: string, browser: string, passed: number, failed: number, flaky: number, total: number, duration: number, status: string, conclusion: string, reportUrl: string, runId: string }} RunEntry */
/** @typedef {{ title: string, errors: string[] }} FailureSummary */
/** @typedef {{ runId: string, branch: string, date: string, failures: FailureSummary[] }} FailureArchive */
/** @typedef {{ title: string, file: string, group: string, status: 'passed'|'failed'|'flaky', duration: number, errors: string[] }} TestCaseResult */
/** @typedef {{ runId: string, branch: string, browser: string, date: string, reportUrl: string, tests: TestCaseResult[] }} TestRunEntry */

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

// ── Archive ALL test results (for tests.html analytics) ─────────────────────

const TEST_RUNS_DIR = "test-runs";

/** @param {string} runPath @param {string} runId @param {string} branch @param {string} browser @param {string} reportUrl */
function archiveTestRun(runPath, runId, branch, browser, reportUrl) {
  const resultsFile = path.join(runPath, "test-results.json");
  if (!fs.existsSync(resultsFile)) return;

  const results = /** @type {TestResults} */ (readJSON(resultsFile));

  /** @type {TestCaseResult[]} */
  const tests = [];

  /** @param {any} spec @param {string} file @param {string} group */
  const processSpec = (spec, file, group) => {
    const allTests = spec.tests ?? [];
    const isFlaky = spec.ok && allTests.some((/** @type {any} */ t) => (t.results?.length ?? 0) > 1);
    const status = !spec.ok ? "failed" : isFlaky ? "flaky" : "passed";
    const errors = !spec.ok
      ? allTests.flatMap((/** @type {any} */ t) =>
        t.results?.flatMap((/** @type {any} */ r) =>
          r.errors?.map((/** @type {any} */ e) => e.message) ?? []
        ) ?? []
      )
      : [];
    const duration = allTests.reduce(
      (/** @type {number} */ sum, /** @type {any} */ t) => sum + (t.results?.[0]?.duration ?? 0),
      0
    );
    tests.push({ title: spec.title, file, group, status, duration, errors: errors.slice(0, 2) });
  };

  /** @param {any} suite @param {string} file @param {string} group */
  const processSuite = (suite, file, group) => {
    for (const spec of (suite.specs ?? [])) processSpec(spec, file, group);
    for (const sub of (suite.suites ?? [])) processSuite(sub, file, sub.title || group);
  };

  for (const fileSuite of (results.suites ?? [])) {
    const file = path.basename(fileSuite.title || fileSuite.file || "unknown.spec.js");
    for (const spec of (fileSuite.specs ?? [])) processSpec(spec, file, "");
    for (const describe of (fileSuite.suites ?? [])) processSuite(describe, file, describe.title || "");
  }

  fs.mkdirSync(TEST_RUNS_DIR, { recursive: true });
  /** @type {TestRunEntry} */
  const entry = { runId, branch, browser, date: new Date().toISOString(), reportUrl, tests };
  writeJSON(path.join(TEST_RUNS_DIR, `${runId}.json`), entry);
  console.log(`Archived ${tests.length} test results for run: ${runId}`);
}

/** @returns {TestRunEntry[]} */
function loadTestRuns() {
  if (!fs.existsSync(TEST_RUNS_DIR)) return [];
  return fs
    .readdirSync(TEST_RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => /** @type {TestRunEntry} */(readJSON(path.join(TEST_RUNS_DIR, f))))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 50);
}

// ── Build per-test analytics across runs ──────────────────────────────────────

/**
 * @typedef {{
 *   title: string, file: string, group: string,
 *   totalRuns: number, passed: number, failed: number, flaky: number, passRate: number,
 *   avgDuration: number, lastStatus: string, lastDate: string,
 *   browsers: Object.<string,{runs:number,passed:number,failed:number,flaky:number}>,
 *   branches: Object.<string,{runs:number,passed:number,failed:number,flaky:number}>,
 *   history: Array<{runId:string,branch:string,browser:string,date:string,status:string,duration:number,errors:string[],reportUrl:string}>
 * }} PerTestStat
 */

/** @param {TestRunEntry[]} runs @returns {PerTestStat[]} */
function buildPerTestAnalytics(runs) {
  /** @type {Map<string, PerTestStat>} */
  const map = new Map();

  for (const run of runs) {
    for (const t of run.tests) {
      // Key by file + title to avoid collisions across spec files
      const key = `${t.file ?? ''}::${t.title}`;
      if (!map.has(key)) {
        map.set(key, {
          title: t.title,
          file: t.file ?? 'unknown',
          group: t.group ?? '',
          totalRuns: 0, passed: 0, failed: 0, flaky: 0, passRate: 0,
          avgDuration: 0, lastStatus: t.status, lastDate: run.date,
          browsers: {}, branches: {}, history: [],
        });
      }
      const stat = /** @type {PerTestStat} */ (map.get(key));

      stat.totalRuns++;
      if (t.status === "passed") stat.passed++;
      else if (t.status === "failed") stat.failed++;
      else stat.flaky++;

      stat.avgDuration = Math.round(
        (stat.avgDuration * (stat.totalRuns - 1) + t.duration) / stat.totalRuns
      );

      if (!stat.browsers[run.browser]) stat.browsers[run.browser] = { runs: 0, passed: 0, failed: 0, flaky: 0 };
      stat.browsers[run.browser].runs++;
      stat.browsers[run.browser][t.status]++;

      if (!stat.branches[run.branch]) stat.branches[run.branch] = { runs: 0, passed: 0, failed: 0, flaky: 0 };
      stat.branches[run.branch].runs++;
      stat.branches[run.branch][t.status]++;

      if (stat.history.length < 20) {
        stat.history.push({
          runId: run.runId, branch: run.branch, browser: run.browser,
          date: run.date, status: t.status, duration: t.duration,
          errors: t.errors, reportUrl: run.reportUrl,
        });
      }
    }
  }

  for (const stat of map.values()) {
    stat.passRate = stat.totalRuns > 0 ? Math.round((stat.passed / stat.totalRuns) * 100) : 0;
  }
  return Array.from(map.values()).sort((a, b) => b.failed - a.failed || a.title.localeCompare(b.title));
}

// ── Generate tests.html ───────────────────────────────────────────────────────

/** @param {PerTestStat[]} testStats @param {string[]} allBrowsers @param {string[]} allBranches */
function generateTestsPage(testStats, allBrowsers, allBranches) {
  const browserIcon = (/** @type {string} */ b) =>
    ({ chrome: "🌐", firefox: "🦊", safari: "🧭", edge: "🔷" })[b.toLowerCase()] ?? "🌐";
  const statusIcon = (/** @type {string} */ s) =>
    ({ passed: "✅", failed: "❌", flaky: "⚠️" })[s] ?? "—";
  const statusClass = (/** @type {string} */ s) =>
    ({ passed: "ts-pass", failed: "ts-fail", flaky: "ts-flaky" })[s] ?? "";

  // Group by spec file → describe group
  /** @type {Map<string, Map<string, PerTestStat[]>>} */
  const byFile = new Map();
  for (const stat of testStats) {
    const f = stat.file || "unknown.spec.js";
    const g = stat.group || "";
    if (!byFile.has(f)) byFile.set(f, new Map());
    const fileMap = /** @type {Map<string,PerTestStat[]>} */ (byFile.get(f));
    if (!fileMap.has(g)) fileMap.set(g, []);
    /** @type {PerTestStat[]} */ (fileMap.get(g)).push(stat);
  }

  const branchOptions = allBranches.map((b) => `<option value="${b}">${b}</option>`).join("");
  const browserOptions = allBrowsers.map((b) => `<option value="${b}">${browserIcon(b)} ${b}</option>`).join("");

  const totalTests = testStats.length;
  const avgPassRate = totalTests > 0
    ? Math.round(testStats.reduce((s, t) => s + t.passRate, 0) / totalTests)
    : 0;
  const mostFlaky = testStats.slice().sort((a, b) => b.flaky - a.flaky)[0];
  const mostFailing = testStats[0];

  /** @param {PerTestStat} stat */
  const renderTestCard = (stat) => {
    const safeId = (stat.file + stat.title).replace(/[^a-zA-Z0-9]/g, "_").substring(0, 50);
    const severityClass = stat.passRate < 50 ? "sev-critical" : stat.passRate < 80 ? "sev-high" : stat.failed > 0 ? "sev-medium" : "sev-good";
    const severityLabel = stat.passRate < 50 ? "Critical" : stat.passRate < 80 ? "High" : stat.failed > 0 ? "Medium" : "Stable";

    const trendDots = stat.history.slice(0, 10).reverse()
      .map((h) => `<span class="ts-dot ts-dot-${h.status}" title="${h.browser} / ${h.date.substring(0, 10)}"></span>`)
      .join("");

    const browserRows = Object.entries(stat.browsers).map(([br, b]) => {
      const rate = b.runs > 0 ? Math.round((b.passed / b.runs) * 100) : 0;
      return `<div class="ts-brow"><span class="ts-brow-name">${browserIcon(br)} ${br}</span><span class="ts-brow-stat ts-pass-txt">${b.passed}P</span><span class="ts-brow-stat ts-fail-txt">${b.failed}F</span><span class="ts-brow-stat ts-flaky-txt">${b.flaky}FL</span><div class="ts-mini-bar"><div class="ts-mini-fill" style="width:${rate}%"></div></div><span class="ts-brow-rate">${rate}%</span></div>`;
    }).join("");

    const branchRows = Object.entries(stat.branches).map(([br, b]) => {
      const rate = b.runs > 0 ? Math.round((b.passed / b.runs) * 100) : 0;
      return `<div class="ts-brow"><span class="ts-brow-name"><span class="branch-tag">${br}</span></span><span class="ts-brow-stat ts-pass-txt">${b.passed}P</span><span class="ts-brow-stat ts-fail-txt">${b.failed}F</span><span class="ts-brow-stat ts-flaky-txt">${b.flaky}FL</span><div class="ts-mini-bar"><div class="ts-mini-fill" style="width:${rate}%"></div></div><span class="ts-brow-rate">${rate}%</span></div>`;
    }).join("");

    const historyRows = stat.history.map((h, idx) => {
      const shortDate = h.date.replace("T", " ").substring(0, 16) + " UTC";
      const errHtml = h.errors.length > 0
        ? `<pre class="ts-error">${h.errors[0].toString().substring(0, 350)}</pre>` : "";
      return `<div class="ts-hist-row ${statusClass(h.status)}"><div class="ts-hist-meta"><span class="ts-status-badge ts-${h.status}">${h.status.toUpperCase()}</span><span class="ts-run-num">${idx === 0 ? "Latest" : "#" + (idx + 1)}</span><span class="branch-tag">${h.branch}</span><span class="ts-hist-browser">${browserIcon(h.browser)} ${h.browser}</span><span class="ts-hist-dur">${(h.duration / 1000).toFixed(1)}s</span><span class="ts-hist-date">${shortDate}</span>${h.reportUrl ? `<a class="view-btn view-btn-sm" href="${h.reportUrl}" target="_blank">Report →</a>` : ""}</div>${errHtml}</div>`;
    }).join("");

    return `
    <div class="ts-card" id="tscard_${safeId}"
         data-title="${stat.title.replace(/"/g, "&quot;")}"
         data-file="${stat.file}"
         data-status="${stat.lastStatus}"
         data-passrate="${stat.passRate}">
      <div class="ts-card-head" onclick="toggleCard('${safeId}')">
        <div class="ts-card-left">
          <span class="ts-sev ${severityClass}">${severityLabel}</span>
          <span class="ts-status-icon">${statusIcon(stat.lastStatus)}</span>
          <span class="ts-title">${stat.title}</span>
        </div>
        <div class="ts-card-right">
          <div class="ts-trend">${trendDots}</div>
          <div class="ts-metrics">
            <span class="ts-met ts-pass-txt" title="Passed">${stat.passed}</span>
            <span class="ts-met-sep">/</span>
            <span class="ts-met ts-fail-txt" title="Failed">${stat.failed}</span>
            <span class="ts-met-sep">/</span>
            <span class="ts-met ts-flaky-txt" title="Flaky">${stat.flaky}</span>
            <span class="ts-rate" title="Pass rate">${stat.passRate}%</span>
            <span class="ts-dur">${(stat.avgDuration / 1000).toFixed(1)}s</span>
          </div>
          <span class="ts-toggle" id="tstoggle_${safeId}">▸</span>
        </div>
      </div>
      <div class="ts-card-body" id="tsbody_${safeId}" style="display:none">
        <div class="ts-detail-grid">
          <div class="ts-detail-col"><div class="ts-detail-title">Browser Breakdown</div>${browserRows || "<div class=\"ts-no-data\">No data</div>"}</div>
          <div class="ts-detail-col"><div class="ts-detail-title">Branch Breakdown</div>${branchRows || "<div class=\"ts-no-data\">No data</div>"}</div>
        </div>
        <div class="ts-detail-title" style="margin:1rem 1rem 0.4rem">Run History (newest first)</div>
        <div class="ts-history">${historyRows}</div>
      </div>
    </div>`;
  };

  /** @param {string} file @param {Map<string,PerTestStat[]>} groups */
  const renderFileGroup = (file, groups) => {
    const allStats = Array.from(groups.values()).flat();
    const fileId = file.replace(/[^a-zA-Z0-9]/g, "_");
    const fp = allStats.reduce((s, t) => s + t.passed, 0);
    const ff = allStats.reduce((s, t) => s + t.failed, 0);
    const ffl = allStats.reduce((s, t) => s + t.flaky, 0);
    const fr = allStats.length > 0 ? Math.round(allStats.reduce((s, t) => s + t.passRate, 0) / allStats.length) : 0;
    const fcolor = fr >= 80 ? "var(--pass)" : fr >= 50 ? "var(--flaky)" : "var(--fail)";

    const groupsHtml = Array.from(groups.entries()).map(([group, stats]) => {
      const groupHeader = group
        ? `<div class="describe-hdr"><span class="describe-icon">🔸</span>${group}</div>`
        : "";
      return `<div class="describe-group">${groupHeader}${stats.map(renderTestCard).join("")}</div>`;
    }).join("");

    return `
    <div class="file-group" id="fg_${fileId}" data-file="${file}">
      <div class="file-hdr" onclick="toggleFileGroup('${fileId}')">
        <span class="file-icon">📄</span>
        <span class="file-name">${file}</span>
        <div class="file-chips">
          <span class="fc">${allStats.length} tests</span>
          <span class="fc fc-p">${fp}✓</span>
          <span class="fc fc-f">${ff}✗</span>
          ${ffl > 0 ? `<span class="fc fc-fl">${ffl}⚠</span>` : ""}
          <span class="fc fc-r" style="color:${fcolor}">${fr}%</span>
        </div>
        <span class="file-toggle" id="ftog_${fileId}">▾</span>
      </div>
      <div class="file-body" id="fb_${fileId}">${groupsHtml}</div>
    </div>`;
  };

  const filesHtml = byFile.size > 0
    ? Array.from(byFile.entries()).map(([f, g]) => renderFileGroup(f, g)).join("")
    : `<div class="empty-state">No test run data yet. Runs are recorded after each CI execution.</div>`;



  // ── HTML ─────────────────────────────────────────────────────────────────────
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test Analytics — Playwright Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Syne:wght@400;600;800&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:#0a0e1a; --surface:#111827; --surface2:#1a2235; --border:#1e2d45;
      --accent:#00e5ff; --accent2:#7c3aed; --pass:#10b981; --fail:#f43f5e;
      --flaky:#f59e0b; --text:#e2e8f0; --muted:#64748b;
      --font-display:'Syne',sans-serif; --font-mono:'JetBrains Mono',monospace;
    }
    body { font-family:var(--font-display); background:var(--bg); color:var(--text); min-height:100vh; overflow-x:hidden; }
    body::before { content:''; position:fixed; inset:0; background-image:linear-gradient(rgba(0,229,255,0.03) 1px,transparent 1px),linear-gradient(90deg,rgba(0,229,255,0.03) 1px,transparent 1px); background-size:40px 40px; animation:gridPan 20s linear infinite; pointer-events:none; z-index:0; }
    @keyframes gridPan { 0%{background-position:0 0} 100%{background-position:40px 40px} }
    .container { position:relative; z-index:1; max-width:1280px; margin:0 auto; padding:2.5rem 2rem; }

    /* ── Nav ── */
    .nav { display:flex; align-items:center; gap:0.5rem; margin-bottom:2rem; flex-wrap:wrap; border-bottom:1px solid var(--border); padding-bottom:1rem; }
    .nav-logo { display:flex; align-items:center; gap:0.75rem; margin-right:auto; }
    .nav-logo-icon { width:38px; height:38px; background:linear-gradient(135deg,var(--accent),var(--accent2)); border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:1.2rem; }
    .nav-logo h1 { font-size:1.1rem; font-weight:800; background:linear-gradient(90deg,#fff,var(--accent)); -webkit-background-clip:text; -webkit-text-fill-color:transparent; }
    .nav-tab { font-family:var(--font-mono); font-size:0.75rem; padding:6px 16px; border-radius:6px; border:1px solid var(--border); color:var(--muted); text-decoration:none; transition:all 0.15s; background:var(--surface2); }
    .nav-tab:hover { border-color:var(--accent); color:var(--accent); }
    .nav-tab.active { background:rgba(0,229,255,0.1); border-color:var(--accent); color:var(--accent); }

    /* ── Summary ── */
    .summary-bar { display:flex; gap:1rem; margin-bottom:2rem; flex-wrap:wrap; }
    .sum-chip { background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:1rem 1.5rem; min-width:140px; position:relative; overflow:hidden; }
    .sum-chip::before { content:''; position:absolute; top:0; left:0; right:0; height:2px; }
    .sum-chip.chip-total::before { background:var(--accent); }
    .sum-chip.chip-pass::before  { background:var(--pass); }
    .sum-chip.chip-fail::before  { background:var(--fail); }
    .sum-chip.chip-flaky::before { background:var(--flaky); }
    .sum-chip.chip-rate::before  { background:linear-gradient(90deg,var(--pass),var(--accent)); }
    .sum-label { font-size:0.65rem; font-family:var(--font-mono); color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:0.4rem; }
    .sum-val { font-size:2rem; font-weight:800; line-height:1; }
    .chip-total .sum-val { color:var(--accent); } .chip-pass .sum-val { color:var(--pass); }
    .chip-fail  .sum-val { color:var(--fail);  } .chip-flaky .sum-val { color:var(--flaky); }
    .chip-rate  .sum-val { color:var(--text);  }
    .sum-sub { font-size:0.68rem; font-family:var(--font-mono); color:var(--muted); margin-top:0.3rem; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px; }

    /* ── Controls ── */
    .controls { display:flex; align-items:center; gap:0.75rem; padding:0.85rem 1.25rem; background:var(--surface); border:1px solid var(--border); border-radius:12px; margin-bottom:1.25rem; flex-wrap:wrap; }
    .search-wrap { position:relative; flex:1; min-width:200px; }
    .search-icon { position:absolute; left:10px; top:50%; transform:translateY(-50%); pointer-events:none; }
    .search-input { width:100%; padding:6px 10px 6px 30px; background:var(--surface2); color:var(--text); border:1px solid var(--border); border-radius:6px; font-family:var(--font-mono); font-size:0.78rem; outline:none; transition:border-color 0.15s; }
    .search-input:focus { border-color:var(--accent); }
    .search-input::placeholder { color:var(--muted); }
    .filter-select { font-family:var(--font-mono); font-size:0.75rem; background:var(--surface2); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:5px 10px; cursor:pointer; outline:none; }
    .filter-select:focus { border-color:var(--accent); }
    .count-badge { font-size:0.72rem; font-family:var(--font-mono); color:var(--muted); background:var(--surface2); padding:2px 10px; border-radius:20px; border:1px solid var(--border); }

    /* ── File group ── */
    .file-group { margin-bottom:1rem; border:1px solid var(--border); border-radius:12px; overflow:hidden; }
    .file-hdr { display:flex; align-items:center; gap:0.75rem; padding:0.85rem 1.25rem; cursor:pointer; background:var(--surface2); transition:background 0.15s; flex-wrap:wrap; gap:0.5rem; }
    .file-hdr:hover { background:rgba(0,229,255,0.05); }
    .file-icon { font-size:1rem; flex-shrink:0; }
    .file-name { font-family:var(--font-mono); font-size:0.9rem; font-weight:700; color:var(--accent); flex:1; }
    .file-chips { display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap; }
    .fc { font-family:var(--font-mono); font-size:0.68rem; padding:2px 8px; border-radius:4px; background:var(--surface); border:1px solid var(--border); color:var(--muted); }
    .fc-p { color:var(--pass); border-color:rgba(16,185,129,0.3); }
    .fc-f { color:var(--fail); border-color:rgba(244,63,94,0.3); }
    .fc-fl { color:var(--flaky); border-color:rgba(245,158,11,0.3); }
    .fc-r { font-weight:700; }
    .file-toggle { font-size:0.85rem; color:var(--muted); flex-shrink:0; transition:transform 0.2s; }
    .file-body { padding:0.5rem; display:flex; flex-direction:column; gap:0.35rem; }

    /* ── Describe group ── */
    .describe-group { margin-bottom:0.25rem; }
    .describe-hdr { font-family:var(--font-mono); font-size:0.72rem; color:var(--muted); padding:0.4rem 0.5rem 0.25rem; text-transform:uppercase; letter-spacing:0.06em; display:flex; align-items:center; gap:0.4rem; }
    .describe-icon { font-size:0.8rem; }

    /* ── Test card ── */
    .ts-card { border:1px solid var(--border); border-radius:8px; overflow:hidden; transition:border-color 0.15s,box-shadow 0.15s; background:var(--surface); }
    .ts-card:hover { border-color:rgba(0,229,255,0.25); box-shadow:0 2px 12px rgba(0,229,255,0.06); }
    .ts-card-head { display:flex; align-items:center; justify-content:space-between; padding:0.65rem 1rem; cursor:pointer; background:var(--surface2); gap:0.75rem; flex-wrap:wrap; transition:background 0.15s; }
    .ts-card-head:hover { background:rgba(0,229,255,0.04); }
    .ts-card-left { display:flex; align-items:center; gap:0.55rem; flex:1; min-width:0; }
    .ts-card-right { display:flex; align-items:center; gap:0.75rem; flex-shrink:0; flex-wrap:wrap; }
    .ts-title { font-size:0.83rem; font-weight:600; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:520px; }
    .ts-status-icon { font-size:0.9rem; flex-shrink:0; }
    .ts-sev { font-size:0.6rem; font-family:var(--font-mono); font-weight:700; padding:2px 7px; border-radius:4px; letter-spacing:0.06em; text-transform:uppercase; flex-shrink:0; }
    .sev-critical { background:rgba(244,63,94,0.2); color:#fb7185; border:1px solid rgba(244,63,94,0.4); }
    .sev-high { background:rgba(245,158,11,0.15); color:#fbbf24; border:1px solid rgba(245,158,11,0.35); }
    .sev-medium { background:rgba(124,58,237,0.15); color:#a78bfa; border:1px solid rgba(124,58,237,0.3); }
    .sev-good { background:rgba(16,185,129,0.12); color:#34d399; border:1px solid rgba(16,185,129,0.3); }
    .ts-trend { display:flex; align-items:center; gap:3px; }
    .ts-dot { width:9px; height:9px; border-radius:2px; flex-shrink:0; }
    .ts-dot-passed { background:var(--pass); } .ts-dot-failed { background:var(--fail); } .ts-dot-flaky { background:var(--flaky); }
    .ts-metrics { display:flex; align-items:center; gap:0.45rem; font-family:var(--font-mono); }
    .ts-met { font-size:0.78rem; font-weight:700; } .ts-met-sep { font-size:0.7rem; color:var(--muted); }
    .ts-pass-txt { color:var(--pass); } .ts-fail-txt { color:var(--fail); } .ts-flaky-txt { color:var(--flaky); }
    .ts-rate { font-size:0.7rem; color:var(--muted); background:var(--surface); border:1px solid var(--border); padding:1px 7px; border-radius:10px; }
    .ts-dur { font-size:0.68rem; color:var(--muted); }
    .ts-toggle { font-size:0.85rem; color:var(--muted); transition:transform 0.2s; flex-shrink:0; }

    /* ── Card body ── */
    .ts-card-body { border-top:1px solid var(--border); }
    .ts-detail-grid { display:grid; grid-template-columns:1fr 1fr; gap:0; border-bottom:1px solid var(--border); }
    .ts-detail-col { padding:0.85rem 1rem; }
    .ts-detail-col:first-child { border-right:1px solid var(--border); }
    .ts-detail-title { font-size:0.65rem; font-family:var(--font-mono); color:var(--muted); text-transform:uppercase; letter-spacing:0.08em; margin-bottom:0.5rem; }
    .ts-no-data { font-size:0.72rem; font-family:var(--font-mono); color:var(--muted); }
    .ts-brow { display:flex; align-items:center; gap:0.5rem; margin-bottom:0.35rem; flex-wrap:wrap; }
    .ts-brow-name { font-family:var(--font-mono); font-size:0.75rem; min-width:100px; }
    .ts-brow-stat { font-family:var(--font-mono); font-size:0.68rem; font-weight:700; min-width:28px; }
    .ts-mini-bar { flex:1; height:6px; background:var(--surface); border-radius:3px; overflow:hidden; min-width:50px; border:1px solid var(--border); }
    .ts-mini-fill { height:100%; background:linear-gradient(90deg,var(--pass),#34d399); border-radius:3px; }
    .ts-brow-rate { font-family:var(--font-mono); font-size:0.68rem; color:var(--muted); min-width:32px; text-align:right; }

    /* ── History ── */
    .ts-hist-row { padding:0.6rem 1rem; border-top:1px solid var(--border); transition:background 0.1s; }
    .ts-hist-row:first-child { border-top:none; }
    .ts-hist-row:hover { background:rgba(0,229,255,0.03); }
    .ts-hist-meta { display:flex; align-items:center; gap:0.6rem; margin-bottom:0.35rem; flex-wrap:wrap; }
    .ts-status-badge { font-size:0.6rem; font-family:var(--font-mono); font-weight:700; padding:1px 6px; border-radius:3px; letter-spacing:0.05em; }
    .ts-passed { background:rgba(16,185,129,0.15); color:var(--pass); border:1px solid rgba(16,185,129,0.3); }
    .ts-failed { background:rgba(244,63,94,0.15); color:var(--fail); border:1px solid rgba(244,63,94,0.3); }
    .ts-flaky  { background:rgba(245,158,11,0.15); color:var(--flaky); border:1px solid rgba(245,158,11,0.3); }
    .ts-run-num { font-family:var(--font-mono); font-size:0.72rem; color:var(--muted); min-width:40px; }
    .ts-hist-browser { font-family:var(--font-mono); font-size:0.72rem; color:var(--text); }
    .ts-hist-dur { font-family:var(--font-mono); font-size:0.7rem; color:var(--muted); }
    .ts-hist-date { font-family:var(--font-mono); font-size:0.7rem; color:var(--muted); margin-left:auto; }
    .ts-error { font-family:var(--font-mono); font-size:0.7rem; color:#fca5a5; background:rgba(244,63,94,0.06); border:1px solid rgba(244,63,94,0.15); border-radius:6px; padding:0.5rem 0.75rem; white-space:pre-wrap; word-break:break-all; max-height:110px; overflow-y:auto; line-height:1.5; }

    /* ── Shared ── */
    .branch-tag { font-family:var(--font-mono); font-size:0.72rem; background:var(--surface2); border:1px solid var(--border); padding:2px 7px; border-radius:4px; color:var(--accent); }
    .view-btn { display:inline-flex; align-items:center; gap:4px; color:var(--accent); text-decoration:none; font-size:0.75rem; font-family:var(--font-mono); padding:3px 9px; border:1px solid rgba(0,229,255,0.2); border-radius:5px; transition:all 0.2s; background:rgba(0,229,255,0.05); }
    .view-btn:hover { background:rgba(0,229,255,0.12); border-color:var(--accent); }
    .view-btn-sm { font-size:0.66rem; padding:1px 7px; }
    .empty-state { text-align:center; padding:3rem; font-family:var(--font-mono); font-size:0.8rem; color:var(--muted); }
    footer { text-align:center; padding:2rem 0 1rem; font-family:var(--font-mono); font-size:0.7rem; color:var(--muted); }

    @media(max-width:768px) {
      .ts-detail-grid { grid-template-columns:1fr; }
      .ts-title { max-width:200px; }
      .ts-hist-date { display:none; }
      .breakdown-row { grid-template-columns:1fr; }
    }
  </style>
</head>
<body>
<div class="container">
  <nav class="nav">
    <div class="nav-logo"><div class="nav-logo-icon">🎭</div><h1>Playwright Dashboard</h1></div>
    <a href="index.html" class="nav-tab">📊 Overview</a>
    <a href="tests.html" class="nav-tab active">🧪 Test Analytics</a>
  </nav>

  <div class="summary-bar">
    <div class="sum-chip chip-total"><div class="sum-label">Unique Tests</div><div class="sum-val">${totalTests}</div><div class="sum-sub">tracked across all runs</div></div>
    <div class="sum-chip chip-rate"><div class="sum-label">Avg Pass Rate</div><div class="sum-val">${avgPassRate}%</div><div class="sum-sub">across all tests &amp; runs</div></div>
    <div class="sum-chip chip-fail"><div class="sum-label">Most Failing</div><div class="sum-val">${mostFailing ? mostFailing.failed : 0}</div><div class="sum-sub">${mostFailing ? mostFailing.title.substring(0, 30) + '…' : '—'}</div></div>
    <div class="sum-chip chip-flaky"><div class="sum-label">Most Flaky</div><div class="sum-val">${mostFlaky ? mostFlaky.flaky : 0}</div><div class="sum-sub">${mostFlaky ? mostFlaky.title.substring(0, 30) + '…' : '—'}</div></div>
  </div>

  <div class="controls">
    <div class="search-wrap"><span class="search-icon">🔍</span><input class="search-input" id="tsSearch" type="text" placeholder="Search test or spec file…" oninput="filter()" /></div>
    <select class="filter-select" id="fBrowser" onchange="filter()"><option value="all">All browsers</option>${browserOptions}</select>
    <select class="filter-select" id="fBranch" onchange="filter()"><option value="all">All branches</option>${branchOptions}</select>
    <select class="filter-select" id="fStatus" onchange="filter()">
      <option value="all">All statuses</option>
      <option value="passed">✅ Passed last</option>
      <option value="failed">❌ Failed last</option>
      <option value="flaky">⚠️ Flaky last</option>
    </select>
    <span class="count-badge" id="tsCount">${totalTests} tests</span>
  </div>

  <div id="fileList">${filesHtml}</div>

  <footer>Playwright Test Analytics · ${new Date().toISOString().replace("T", " ").substring(0, 19)} UTC</footer>
</div>

<script>
  function toggleCard(id) {
    const body = document.getElementById('tsbody_' + id);
    const tog  = document.getElementById('tstoggle_' + id);
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    if (tog) tog.textContent = open ? '▸' : '▾';
  }

  function toggleFileGroup(id) {
    const body = document.getElementById('fb_' + id);
    const tog  = document.getElementById('ftog_' + id);
    if (!body) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : '';
    if (tog) tog.textContent = open ? '▸' : '▾';
  }

  function filter() {
    const q      = (document.getElementById('tsSearch').value || '').toLowerCase().trim();
    const status = document.getElementById('fStatus').value;
    const browser= document.getElementById('fBrowser').value;
    const branch = document.getElementById('fBranch').value;

    let visible = 0;

    document.querySelectorAll('.ts-card').forEach(card => {
      const title  = (card.getAttribute('data-title') || '').toLowerCase();
      const file   = (card.getAttribute('data-file')  || '').toLowerCase();
      const lastSt = card.getAttribute('data-status') || '';
      const matchQ  = !q || title.includes(q) || file.includes(q);
      const matchSt = status === 'all' || lastSt === status;

      let matchBr = browser === 'all';
      if (!matchBr) card.querySelectorAll('.ts-hist-browser').forEach(el => { if (el.textContent.toLowerCase().includes(browser)) matchBr = true; });

      let matchBranch = branch === 'all';
      if (!matchBranch) card.querySelectorAll('.branch-tag').forEach(el => { if (el.textContent.trim() === branch) matchBranch = true; });

      const show = matchQ && matchSt && matchBr && matchBranch;
      card.style.display = show ? '' : 'none';
      if (show) visible++;
    });

    // Propagate: hide describe-groups and file-groups that have no visible tests
    document.querySelectorAll('.describe-group').forEach(dg => {
      const has = Array.from(dg.querySelectorAll('.ts-card')).some(c => c.style.display !== 'none');
      dg.style.display = has ? '' : 'none';
    });
    document.querySelectorAll('.file-group').forEach(fg => {
      const has = Array.from(fg.querySelectorAll('.ts-card')).some(c => c.style.display !== 'none');
      fg.style.display = has ? '' : 'none';
    });

    document.getElementById('tsCount').textContent = visible + ' test' + (visible !== 1 ? 's' : '');
  }
</script>
</body>
</html>`;

  fs.writeFileSync("tests.html", html);
  console.log(`Test analytics page generated with ${testStats.length} unique tests.`);
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

    // Also prune test-runs archive entry
    const testRunFile = path.join(TEST_RUNS_DIR, `${run}.json`);
    if (fs.existsSync(testRunFile)) {
      fs.rmSync(testRunFile);
      console.log(`Removed test-runs entry: ${run}.json`);
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

  // ── Trend chart data (last 20 runs, oldest→newest) ─────────────────────────
  const trendData = history.slice(0, 20).reverse();
  const chartW = 800, chartH = 120;
  const passPoints = trendData
    .map((r, i) => {
      const x = trendData.length > 1 ? (i / (trendData.length - 1)) * chartW : chartW / 2;
      const y = chartH - ((r.total > 0 ? r.passed / r.total : 0) * chartH);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  const durMax = Math.max(...trendData.map(r => r.duration ?? 0), 1);
  const durPoints = trendData
    .map((r, i) => {
      const x = trendData.length > 1 ? (i / (trendData.length - 1)) * chartW : chartW / 2;
      const y = chartH - (((r.duration ?? 0) / durMax) * chartH);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  // Fill polygon for pass-rate area
  const firstX = trendData.length > 1 ? 0 : chartW / 2;
  const lastX = trendData.length > 1 ? chartW : chartW / 2;
  const passArea = `${firstX},${chartH} ${passPoints} ${lastX},${chartH}`;

  // X-axis labels: every ~4th run
  const xLabels = trendData
    .map((r, i) => {
      if (i % Math.max(1, Math.floor(trendData.length / 5)) !== 0 && i !== trendData.length - 1) return '';
      const x = trendData.length > 1 ? (i / (trendData.length - 1)) * chartW : chartW / 2;
      return `<text x="${x.toFixed(1)}" y="${chartH + 16}" text-anchor="middle" font-size="9" fill="#64748b" font-family="monospace">${r.date?.substring(5, 16) ?? ''}</text>`;
    }).join('');

  // ── Insight cards ──────────────────────────────────────────────────────────
  // Failure streak
  let streak = 0, maxStreak = 0, streakBranch = latestRun?.branch ?? '';
  for (const r of history) {
    if (r.failed > 0) { streak++; if (streak > maxStreak) { maxStreak = streak; streakBranch = r.branch; } }
    else streak = 0;
  }
  // Current streak (from newest)
  let currentStreak = 0;
  for (const r of history) {
    if (r.failed > 0) currentStreak++;
    else break;
  }

  // Avg test-level pass rate
  const avgTestPassRate = history.length > 0
    ? Math.round(history.reduce((s, r) => s + (r.total > 0 ? (r.passed / r.total) * 100 : 0), 0) / history.length)
    : 0;

  // Fastest + slowest run
  const runsWithDur = history.filter(r => r.duration && r.duration > 0);
  const fastest = runsWithDur.length > 0 ? runsWithDur.reduce((a, b) => (a.duration ?? 0) < (b.duration ?? 0) ? a : b) : null;
  const slowest = runsWithDur.length > 0 ? runsWithDur.reduce((a, b) => (a.duration ?? 0) > (b.duration ?? 0) ? a : b) : null;

  // Most active branch
  const branchCounts = /** @type {Record<string,number>} */ ({});
  history.forEach(r => { branchCounts[r.branch] = (branchCounts[r.branch] ?? 0) + 1; });
  const mostActiveBranch = Object.entries(branchCounts).sort((a, b) => b[1] - a[1])[0];

  // ── Browser breakdown ──────────────────────────────────────────────────────
  const browserIcon = (/** @type {string} */ b) =>
    ({ chrome: "🌐", firefox: "🦊", safari: "🧭", edge: "🔷" })[b?.toLowerCase()] ?? "🌐";

  /** @type {Record<string,{runs:number,passed:number,failed:number}>} */
  const browserStats = {};
  history.forEach(r => {
    if (!r.browser) return;
    if (!browserStats[r.browser]) browserStats[r.browser] = { runs: 0, passed: 0, failed: 0 };
    browserStats[r.browser].runs++;
    if (r.failed === 0) browserStats[r.browser].passed++;
    else browserStats[r.browser].failed++;
  });

  /** @type {Record<string,{runs:number,passed:number,failed:number}>} */
  const branchStats = {};
  history.forEach(r => {
    if (!branchStats[r.branch]) branchStats[r.branch] = { runs: 0, passed: 0, failed: 0 };
    branchStats[r.branch].runs++;
    if (r.failed === 0) branchStats[r.branch].passed++;
    else branchStats[r.branch].failed++;
  });

  const renderBreakdownBar = (/** @type {string} */ name, /** @type {{runs:number,passed:number,failed:number}} */ s, /** @type {string} */ icon) => {
    const rate = s.runs > 0 ? Math.round((s.passed / s.runs) * 100) : 0;
    const color = rate >= 80 ? 'var(--pass)' : rate >= 50 ? 'var(--flaky)' : 'var(--fail)';
    return `
      <div class="bd-row">
        <span class="bd-name">${icon} ${name}</span>
        <span class="bd-runs">${s.runs} runs</span>
        <div class="bd-bar-wrap"><div class="bd-bar-fill" style="width:${rate}%;background:${color}"></div></div>
        <span class="bd-rate" style="color:${color}">${rate}%</span>
        <span class="bd-counts"><span class="bd-pass">${s.passed}✓</span> <span class="bd-fail">${s.failed}✗</span></span>
      </div>`;
  };

  const browserBreakdownHTML = Object.entries(browserStats)
    .sort((a, b) => b[1].runs - a[1].runs)
    .map(([b, s]) => renderBreakdownBar(b, s, browserIcon(b))).join('');

  const branchBreakdownHTML = Object.entries(branchStats)
    .sort((a, b) => b[1].runs - a[1].runs)
    .map(([b, s]) => renderBreakdownBar(b, s, '🌿')).join('');

  // Sparkline (small — still used in stat cards)
  const sparkData = history.slice(0, 20).reverse()
    .map((r) => (r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0));
  const sparkW = 120, sparkH = 32;
  const sparkPoints = sparkData
    .map((v, i) => {
      const x = (i / Math.max(sparkData.length - 1, 1)) * sparkW;
      const y = sparkH - (v / 100) * sparkH;
      return `${x},${y}`;
    }).join(" ");

  const branchOptions = branches.map((b) => `<option value="${b}">${b}</option>`).join("");
  const browserOptions = browsers.map((b) => `<option value="${b}">${b}</option>`).join("");

  // (Failure history section removed — test analytics now live on tests.html)


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

    /* ── Navigation tabs ── */
    .nav-tabs { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 2rem; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 1rem; }
    .nav-tab { font-family: var(--font-mono); font-size: 0.76rem; padding: 6px 16px; border-radius: 6px; border: 1px solid var(--border); color: var(--muted); text-decoration: none; transition: all 0.15s ease; background: var(--surface2); }
    .nav-tab:hover { border-color: var(--accent); color: var(--accent); }
    .nav-tab.active { background: rgba(0,229,255,0.1); border-color: var(--accent); color: var(--accent); }

    /* ── Trend chart ── */
    .chart-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 1.25rem 1.5rem; margin-bottom: 1.5rem; animation: slideUp 0.5s 0.28s ease both; }
    .chart-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem; }
    .chart-title { font-size: 0.8rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; }
    .chart-legend { display: flex; align-items: center; gap: 1rem; }
    .legend-item { display: flex; align-items: center; gap: 5px; font-size: 0.68rem; font-family: var(--font-mono); color: var(--muted); }
    .legend-dot { width: 8px; height: 8px; border-radius: 2px; }
    .chart-svg-wrap { width: 100%; overflow-x: auto; }
    .chart-svg { display: block; width: 100%; }

    /* ── Insights row ── */
    .insights-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 1.5rem; }
    .insight-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.25rem; position: relative; overflow: hidden; animation: slideUp 0.5s 0.32s ease both; }
    .insight-card::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px; }
    .insight-streak::before { background: var(--fail); }
    .insight-rate::before   { background: linear-gradient(90deg, var(--pass), var(--accent)); }
    .insight-speed::before  { background: var(--accent); }
    .insight-branch::before { background: var(--accent2); }
    .insight-icon { font-size: 1.4rem; margin-bottom: 0.4rem; }
    .insight-label { font-size: 0.65rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.25rem; }
    .insight-value { font-size: 1.5rem; font-weight: 800; line-height: 1; letter-spacing: -0.02em; margin-bottom: 0.25rem; }
    .insight-streak .insight-value { color: var(--fail); }
    .insight-rate   .insight-value { color: var(--text); }
    .insight-speed  .insight-value { color: var(--accent); }
    .insight-branch .insight-value { color: var(--accent2); }
    .insight-sub { font-size: 0.7rem; font-family: var(--font-mono); color: var(--muted); }

    /* ── Breakdown panels ── */
    .breakdown-row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; }
    .bd-panel { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 1rem 1.25rem; animation: slideUp 0.5s 0.35s ease both; }
    .bd-panel-title { font-size: 0.72rem; font-family: var(--font-mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.85rem; }
    .bd-row { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.55rem; flex-wrap: nowrap; }
    .bd-name { font-family: var(--font-mono); font-size: 0.78rem; min-width: 90px; }
    .bd-runs { font-family: var(--font-mono); font-size: 0.68rem; color: var(--muted); min-width: 54px; }
    .bd-bar-wrap { flex: 1; height: 8px; background: var(--surface2); border-radius: 4px; overflow: hidden; border: 1px solid var(--border); min-width: 40px; }
    .bd-bar-fill { height: 100%; border-radius: 4px; transition: width 0.6s ease; }
    .bd-rate { font-family: var(--font-mono); font-size: 0.72rem; font-weight: 700; min-width: 34px; text-align: right; }
    .bd-counts { font-family: var(--font-mono); font-size: 0.65rem; min-width: 60px; text-align: right; }
    .bd-pass { color: var(--pass); }
    .bd-fail { color: var(--fail); }

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
      .breakdown-row { grid-template-columns: 1fr; }
      .insights-row { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="container">
    <nav class="nav-tabs">
      <a href="index.html" class="nav-tab active">📊 Overview</a>
      <a href="tests.html" class="nav-tab">🧪 Test Analytics</a>
    </nav>

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
        <div class="stat-label">Avg Test Pass Rate</div>
        <div class="stat-value">${avgTestPassRate}%</div>
        <div class="stat-sub">test-level across all runs</div>
      </div>
      <div class="stat-card card-flaky">
        <div class="stat-label">Flaky Tests</div>
        <div class="stat-value">${totalFlaky}</div>
        <div class="stat-sub">total retried passes</div>
      </div>
    </div>

    ${latestRun ? `
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
    </div>` : ""}

    <!-- ── Trend Chart ── -->
    <div class="chart-panel">
      <div class="chart-header">
        <span class="chart-title">📈 Pass Rate &amp; Duration Trend — last ${trendData.length} runs</span>
        <div class="chart-legend">
          <div class="legend-item"><div class="legend-dot" style="background:var(--pass)"></div>Pass rate</div>
          <div class="legend-item"><div class="legend-dot" style="background:var(--accent)"></div>Duration</div>
        </div>
      </div>
      <div class="chart-svg-wrap">
        <svg class="chart-svg" viewBox="-30 -10 ${chartW + 40} ${chartH + 30}" preserveAspectRatio="xMidYMid meet">
          <!-- Grid lines -->
          ${[0, 25, 50, 75, 100].map(v => {
    const y = chartH - (v / 100) * chartH;
    return `<line x1="0" y1="${y.toFixed(1)}" x2="${chartW}" y2="${y.toFixed(1)}" stroke="rgba(255,255,255,0.05)" stroke-width="1"/>
                    <text x="-4" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="9" fill="#64748b" font-family="monospace">${v}%</text>`;
  }).join('')}
          <!-- X axis labels -->
          ${xLabels}
          <!-- Duration line -->
          <polyline points="${durPoints}" fill="none" stroke="rgba(0,229,255,0.4)" stroke-width="1.5" stroke-dasharray="4 3" stroke-linecap="round"/>
          <!-- Pass rate fill -->
          <polygon points="${passArea}" fill="rgba(16,185,129,0.08)"/>
          <!-- Pass rate line -->
          <polyline points="${passPoints}" fill="none" stroke="var(--pass)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
          <!-- Data point dots -->
          ${trendData.map((r, i) => {
    const x = trendData.length > 1 ? (i / (trendData.length - 1)) * chartW : chartW / 2;
    const y = chartH - ((r.total > 0 ? r.passed / r.total : 0) * chartH);
    const color = r.failed > 0 ? 'var(--fail)' : 'var(--pass)';
    const rate = r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${color}" stroke="var(--bg)" stroke-width="1.5">
                      <title>${r.date} · ${r.browser} · ${rate}% · ${r.passed}P ${r.failed}F</title>
                    </circle>`;
  }).join('')}
        </svg>
      </div>
    </div>

    <!-- ── Insight Cards ── -->
    <div class="insights-row">
      <div class="insight-card insight-streak">
        <div class="insight-icon">🔥</div>
        <div class="insight-label">Current Fail Streak</div>
        <div class="insight-value">${currentStreak}</div>
        <div class="insight-sub">${currentStreak > 0 ? `consecutive failing runs on <strong>${latestRun?.branch}</strong>` : 'No active failing streak'}</div>
      </div>
      <div class="insight-card insight-rate">
        <div class="insight-icon">🎯</div>
        <div class="insight-label">Avg Test Pass Rate</div>
        <div class="insight-value">${avgTestPassRate}%</div>
        <div class="insight-sub">test-level average across ${totalRuns} runs</div>
      </div>
      <div class="insight-card insight-speed">
        <div class="insight-icon">⚡</div>
        <div class="insight-label">Fastest Run</div>
        <div class="insight-value">${fastest ? (fastest.duration / 1000).toFixed(1) + 's' : '—'}</div>
        <div class="insight-sub">${fastest ? fastest.browser + ' / ' + fastest.branch : 'No data yet'}</div>
      </div>
      <div class="insight-card insight-branch">
        <div class="insight-icon">🌿</div>
        <div class="insight-label">Most Active Branch</div>
        <div class="insight-value">${mostActiveBranch ? mostActiveBranch[1] : 0}</div>
        <div class="insight-sub">${mostActiveBranch ? `runs on <strong>${mostActiveBranch[0]}</strong>` : 'No data'}</div>
      </div>
    </div>

    <!-- ── Browser & Branch Breakdown ── -->
    <div class="breakdown-row">
      <div class="bd-panel">
        <div class="bd-panel-title">🌐 Browser Breakdown</div>
        ${browserBreakdownHTML || '<div style="font-size:0.75rem;color:var(--muted);font-family:monospace">No data yet</div>'}
      </div>
      <div class="bd-panel">
        <div class="bd-panel-title">🌿 Branch Breakdown</div>
        ${branchBreakdownHTML || '<div style="font-size:0.75rem;color:var(--muted);font-family:monospace">No data yet</div>'}
      </div>
    </div>

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

  // Archive all test results (used for tests.html analytics)
  archiveTestRun(REPORT_PATH, RUN_ID, BRANCH, BROWSER, entry.reportUrl);

  cleanOldRuns(BRANCH, KEEP_RUNS, KEEP_FAILED_RUNS, history);

  const failureArchive = loadFailureArchive();
  generateDashboard(history, failureArchive);

  // Build per-test analytics and generate tests.html
  const testRuns = loadTestRuns();
  const testStats = buildPerTestAnalytics(testRuns);
  const allBrowsers = [...new Set(testRuns.map(r => r.browser).filter(Boolean))];
  const allBranches = [...new Set(testRuns.map(r => r.branch).filter(Boolean))];
  generateTestsPage(testStats, allBrowsers, allBranches);

  console.log(`Dashboard regenerated with ${history.length} runs, ${failureArchive.length} failure archive entries, ${testStats.length} unique tests.`);
}

main();
