const vscode = require("vscode");
const { randomBytes } = require("node:crypto");

/** The dashboard receives data through messages, never through generated markup.
 * @param {import('vscode').Webview} webview
 * @param {import('vscode').Uri} extensionUri */
function getWebviewHTML(webview, extensionUri) {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "dashboard.js"));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "dashboard.css"));
  const nonce = randomBytes(24).toString("base64");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>DevStreak Activity</title>
</head>
<body>
  <main class="dashboard" aria-busy="true" id="dashboard">
    <header class="page-header">
      <div>
        <p class="eyebrow">DEVSTREAK</p>
        <h1>Your activity</h1>
        <p class="subtitle">A little progress, every day.</p>
      </div>
      <div class="header-actions">
        <span class="tracking-status" id="tracking-status" role="status"><span class="status-dot" aria-hidden="true"></span><span id="status-text">Connecting</span></span>
        <button class="button secondary" id="pause-button" type="button" disabled>Pause</button>
        <button class="button quiet" id="settings-button" type="button">Settings</button>
        <details class="data-menu" id="data-menu">
          <summary class="button quiet" aria-label="Manage activity data">More <span aria-hidden="true">⌄</span></summary>
          <div class="data-menu-content">
            <p class="menu-label">YOUR DATA</p>
            <button type="button" data-action="exportJson">Back up as JSON</button>
            <button type="button" data-action="exportCsv">Export as CSV</button>
            <button type="button" data-action="importJson">Import JSON backup</button>
            <div class="menu-divider"></div>
            <button class="danger" type="button" data-action="clearHistory">Clear history…</button>
          </div>
        </details>
      </div>
    </header>

    <section class="storage-banner" id="storage-banner" aria-label="History recovery" hidden>
      <p id="storage-error"></p>
      <button class="button secondary" id="recover-button" type="button">Recover history</button>
    </section>
    <section class="onboarding" id="onboarding" aria-labelledby="onboarding-title" hidden>
      <div>
        <h2 id="onboarding-title">Your first session starts here</h2>
        <p>Open a file, then type, move the cursor, or scroll to start tracking. Reading and thinking count between editor interactions until tracking becomes idle.</p>
        <p id="onboarding-paused" hidden>Tracking is paused. Use Resume above when you are ready.</p>
      </div>
      <button class="button secondary" id="daily-goal-button" type="button">Set daily goal</button>
    </section>

    <section class="summary-grid" aria-label="Activity summary">
      <article class="summary-card">
        <h2>Today</h2>
        <p class="summary-value" id="today-value">—</p>
        <p class="summary-caption">Active coding time</p>
      </article>
      <article class="summary-card">
        <h2>This week</h2>
        <p class="summary-value" id="week-value">—</p>
        <p class="summary-caption" id="week-caption">Active coding time</p>
      </article>
      <article class="summary-card">
        <h2>Current streak</h2>
        <p class="summary-value" id="streak-value">—</p>
        <p class="summary-caption" id="longest-value">Build a daily habit</p>
      </article>
      <article class="summary-card goal-card">
        <h2>Daily goal</h2>
        <p class="summary-value" id="goal-value">—</p>
        <progress id="goal-progress" max="100" value="0" aria-label="Daily goal completion"></progress>
        <p class="summary-caption" id="goal-caption">Set your own pace</p>
      </article>
    </section>

    <section class="activity-section" aria-label="Activity history">
      <div class="section-toolbar">
        <div class="section-heading"><h2>Activity calendar</h2><p id="calendar-description">See how your days add up.</p></div>
        <div class="calendar-options">
          <label class="project-label" for="project-filter">Project</label>
          <select id="project-filter" aria-label="Filter by project"><option value="">All projects</option></select>
          <div class="view-switch" role="group" aria-label="Calendar view">
            <button type="button" id="month-view" aria-pressed="true">Month</button>
            <button type="button" id="year-view" aria-pressed="false">Year</button>
          </div>
        </div>
      </div>

      <div class="activity-layout" id="activity-layout">
        <div class="calendar-panel">
          <div class="calendar-navigation">
            <div class="period-navigation">
              <button class="icon-button" id="previous-period" type="button" aria-label="Previous month">←</button>
              <h3 id="period-title">Loading activity…</h3>
              <button class="icon-button" id="next-period" type="button" aria-label="Next month">→</button>
            </div>
            <button class="button quiet today-button" id="today-button" type="button">Today</button>
          </div>
          <div id="calendar" class="calendar-content" aria-label="Activity dates"></div>
          <div class="calendar-footer">
            <p id="streak-threshold">Select a day to explore your activity.</p>
            <div class="legend" aria-label="Active time intensity">
              <span>Less</span>
              <span class="legend-cell" role="img" data-level="0" id="legend-0"></span>
              <span class="legend-cell" role="img" data-level="1" id="legend-1"></span>
              <span class="legend-cell" role="img" data-level="2" id="legend-2"></span>
              <span class="legend-cell" role="img" data-level="3" id="legend-3"></span>
              <span class="legend-cell" role="img" data-level="4" id="legend-4"></span>
              <span>More</span>
            </div>
          </div>
        </div>

        <aside class="day-panel" aria-labelledby="selected-day-title">
          <div class="day-heading"><p class="eyebrow" id="selected-day-context">SELECTED DAY</p><span class="day-badge" id="day-badge" hidden></span></div>
          <h3 id="selected-day-title">Loading…</h3>
          <p class="day-duration" id="day-duration">—</p>
          <p class="day-duration-caption">Active coding time</p>
          <dl class="day-metrics">
            <div><dt title="Includes pasted text and other inserted text.">Characters added</dt><dd id="day-characters">0</dd></div>
            <div><dt>Files edited</dt><dd id="day-file-count">0</dd></div>
          </dl>
          <div class="files-heading"><h4>Edited files</h4><span id="file-project-count"></span></div>
          <div id="file-list"></div>
          <p class="day-note" id="day-note"></p>
        </aside>
      </div>
    </section>

    <section class="analytics-panel trend-panel" aria-labelledby="trend-title">
      <div class="breakdown-toolbar">
        <div class="section-heading"><h2 id="trend-title">Activity trends</h2><p id="trend-context">Daily active time through today.</p></div>
        <div class="view-switch" role="group" aria-label="Activity trend period">
          <button type="button" id="trend-7" aria-pressed="false">7 days</button>
          <button type="button" id="trend-30" aria-pressed="true">30 days</button>
          <button type="button" id="trend-90" aria-pressed="false">90 days</button>
        </div>
      </div>
      <dl class="trend-metrics">
        <div><dt>Total active time</dt><dd id="trend-total">—</dd></div>
        <div><dt>Average per calendar day</dt><dd id="trend-average">—</dd></div>
        <div><dt>Active days</dt><dd id="trend-active-days">—</dd></div>
        <div><dt>Compared with previous period</dt><dd id="trend-change">—</dd></div>
      </dl>
      <p id="trend-maximum" class="trend-scale"></p>
      <div id="trend-chart" class="trend-chart"></div>
      <div class="trend-axis" aria-hidden="true"><span id="trend-start"></span><span id="trend-end"></span></div>
      <p id="trend-empty" class="empty-breakdown" hidden>No active time recorded in this period. Your next session will appear here.</p>
      <details class="trend-data"><summary>View daily values</summary><table><caption id="trend-table-caption">Daily active time</caption><thead><tr><th scope="col">Date</th><th scope="col">Active time</th></tr></thead><tbody id="trend-table-body"></tbody></table></details>
      <p class="analytics-note">Includes inactive days. Hover over a bar or view daily values to see its duration.</p>
    </section>

    <section class="analytics-grid" aria-label="Activity insights">
      <article class="analytics-panel" aria-labelledby="insights-title">
        <div class="section-heading"><h2 id="insights-title">Weekly insights</h2><p id="insights-context">This week through today.</p></div>
        <dl class="insight-metrics">
          <div><dt>Compared with last week</dt><dd><span id="week-change">—</span><p id="week-comparison" class="insight-caption"></p></dd></div>
          <div><dt>Average per active day</dt><dd><span id="week-average">—</span><p id="week-active-days" class="insight-caption"></p></dd></div>
          <div><dt>Days meeting your goal</dt><dd><span id="week-goal-days">—</span><p id="week-goal-context" class="insight-caption"></p></dd></div>
        </dl>
        <p class="analytics-note" id="insights-note">Compare the same weekdays in each week.</p>
      </article>
      <article class="analytics-panel" aria-labelledby="breakdown-title">
        <div class="breakdown-toolbar">
          <div class="section-heading"><h2 id="breakdown-title">Project breakdown</h2><p id="breakdown-context">Active time by project.</p></div>
          <div class="view-switch" role="group" aria-label="Project breakdown period">
            <button type="button" id="breakdown-week" aria-pressed="true">This week</button>
            <button type="button" id="breakdown-month" aria-pressed="false">This month</button>
          </div>
        </div>
        <ul class="project-breakdown" id="project-breakdown" aria-label="Project active time"></ul>
        <p class="empty-breakdown" id="breakdown-empty" hidden>No active time recorded in this period. Your next session will appear here.</p>
        <p class="analytics-note" id="breakdown-total"></p>
      </article>
      <article class="analytics-panel language-panel" aria-labelledby="language-title">
        <div class="breakdown-toolbar">
          <div class="section-heading"><h2 id="language-title">Language breakdown</h2><p id="language-context">Active time by language.</p></div>
          <div class="view-switch" role="group" aria-label="Language breakdown period">
            <button type="button" id="language-week" aria-pressed="true">This week</button>
            <button type="button" id="language-month" aria-pressed="false">This month</button>
          </div>
        </div>
        <ul class="project-breakdown language-breakdown" id="language-breakdown" aria-label="Language active time"></ul>
        <p class="empty-breakdown" id="language-empty" hidden>No active time recorded in this period. Your next session will appear here.</p>
        <p class="analytics-note" id="language-total"></p>
        <p class="analytics-note" id="language-note" hidden>Unknown language includes earlier activity recorded before language tracking was available.</p>
      </article>
    </section>

    <section class="analytics-panel range-panel" aria-labelledby="report-title">
      <div class="section-heading"><h2 id="report-title">Date-range report</h2><p>Review any period and compare it with the preceding period of the same length.</p></div>
      <form id="report-form" class="report-form">
        <label for="report-start">From<input id="report-start" type="date" required></label>
        <label for="report-end">Through<input id="report-end" type="date" required></label>
        <button class="button secondary" type="submit">Apply dates</button>
      </form>
      <p id="report-error" class="report-error" role="alert" hidden></p>
      <p id="report-context" class="analytics-note">Choose dates and apply to see your report. The project filter applies here too.</p>
      <div id="report-results" hidden>
        <dl class="report-metrics">
          <div><dt>Active time</dt><dd id="report-time"></dd></div>
          <div><dt>Active days</dt><dd id="report-days"></dd></div>
          <div><dt>Average per active day</dt><dd id="report-average"></dd></div>
          <div><dt>Goal days</dt><dd id="report-goals"></dd></div>
        </dl>
        <p id="report-comparison" class="analytics-note"></p>
        <div class="report-charts">
          <section aria-labelledby="report-projects-title"><h3 id="report-projects-title">Projects</h3><ul id="report-projects" class="project-breakdown" aria-label="Report project active time"></ul></section>
          <section aria-labelledby="report-languages-title"><h3 id="report-languages-title">Languages</h3><ul id="report-languages" class="project-breakdown" aria-label="Report language active time"></ul></section>
        </div>
        <p id="report-empty" class="empty-breakdown" hidden>No active time recorded in this period.</p>
      </div>
    </section>

    <footer class="page-footer">
      <div class="save-state" id="save-state">
        <span id="save-status" role="status" aria-live="polite">Connecting…</span>
        <button class="button secondary" id="retry-save-button" type="button" hidden>Retry save</button>
        <span class="save-error" id="save-error" hidden></span>
      </div>
      <span>Reading and thinking count while your session is active.</span>
    </footer>
    <p class="screen-reader-only" id="calendar-announcement" aria-live="polite"></p>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { getWebviewHTML };
