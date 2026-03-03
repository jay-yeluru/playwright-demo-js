const fs = require("fs");
const results = JSON.parse(
  fs.readFileSync(`${process.env.REPORT_PATH}/test-results.json`, "utf8"),
);
const passed = results.suites
  .flatMap((s) => s.specs)
  .filter((s) => s.ok).length;
const failed = results.suites
  .flatMap((s) => s.specs)
  .filter((s) => !s.ok).length;
const total = passed + failed;
const status = failed === 0 ? "✅" : "❌";
const date =
  new Date().toISOString().replace("T", " ").substring(0, 19) + " UTC";

const { BRANCH, RUN_ID, BROWSER } = process.env;
const reportUrl = `reports/${BRANCH}/${RUN_ID}/index.html`;

const historyFile = "dashboard.json";
const history = fs.existsSync(historyFile)
  ? JSON.parse(fs.readFileSync(historyFile, "utf8"))
  : [];

history.unshift({
  date,
  branch: BRANCH,
  browser: BROWSER,
  passed,
  failed,
  total,
  status,
  reportUrl,
  runId: RUN_ID,
});
if (history.length > 100) history.splice(100);
fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

const rows = history
  .map(
    (r) => `
  <tr class="${r.failed > 0 ? "fail" : "pass"}">
    <td>${r.status}</td>
    <td>${r.date}</td>
    <td><code>${r.branch}</code></td>
    <td>${r.browser}</td>
    <td class="pass-count">${r.passed}</td>
    <td class="fail-count">${r.failed}</td>
    <td>${r.total}</td>
    <td><a href="${r.reportUrl}" target="_blank">View →</a></td>
  </tr>`,
  )
  .join("");

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Playwright Test Dashboard</title>
  <style>
    body { font-family: sans-serif; padding: 2rem; background: #f9f9f9; color: #333; }
    h1 { margin-bottom: 1.5rem; }
    table { border-collapse: collapse; width: 100%; background: white; box-shadow: 0 1px 4px rgba(0,0,0,0.1); border-radius: 6px; overflow: hidden; }
    th { background: #24292f; color: white; padding: 10px 14px; text-align: left; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 10px 14px; border-bottom: 1px solid #eee; font-size: 0.9rem; }
    tr:last-child td { border-bottom: none; }
    tr.pass:hover { background: #f0fff4; }
    tr.fail:hover { background: #fff0f0; }
    .pass-count { color: #2da44e; font-weight: bold; }
    .fail-count { color: #cf222e; font-weight: bold; }
    a { color: #0969da; text-decoration: none; }
    a:hover { text-decoration: underline; }
    code { background: #eee; padding: 2px 6px; border-radius: 4px; font-size: 0.85rem; }
  </style>
</head>
<body>
  <h1>🎭 Playwright Test Dashboard</h1>
  <table>
    <thead>
      <tr>
        <th>Status</th>
        <th>Date</th>
        <th>Branch</th>
        <th>Browser</th>
        <th>Passed</th>
        <th>Failed</th>
        <th>Total</th>
        <th>Report</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;

fs.writeFileSync("index.html", html);
console.log(`Dashboard regenerated with ${history.length} runs.`);
