const vscode = require("vscode");
const { randomBytes } = require("node:crypto");

/** The dashboard receives data through messages, never through generated markup. */
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
              <span class="legend-cell" data-level="0" id="legend-0"></span>
              <span class="legend-cell" data-level="1" id="legend-1"></span>
              <span class="legend-cell" data-level="2" id="legend-2"></span>
              <span class="legend-cell" data-level="3" id="legend-3"></span>
              <span class="legend-cell" data-level="4" id="legend-4"></span>
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

    <footer class="page-footer"><span>Saved on this device.</span><span>Reading and thinking count while your session is active.</span></footer>
    <p class="screen-reader-only" id="calendar-announcement" aria-live="polite"></p>
  </main>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

module.exports = { getWebviewHTML };
