const test = require("node:test");
const assert = require("node:assert/strict");
const { dashboardFixture, webviewHTML } = require("../helpers/dashboard-fixture");

function snapshot(overrides = {}) {
  return {
    type: "snapshot", today: "2026-10-02", status: "tracking", paused: false,
    projectId: "", weekStartsOn: 1, projects: [{ id: "app", name: "app" }],
    days: {
      "2026-10-01": { time: 1800, characters: 10, files: [] },
      "2026-10-02": { time: 900, characters: 5, files: [] },
    },
    summary: { todaySeconds: 900, weekSeconds: 2700, currentStreak: 2, longestStreak: 3, goalSeconds: 3600, qualifyingSeconds: 900 },
    ...overrides,
  };
}

test("dashboard starts on today with weekday-aligned dates, summaries, and disabled future days", () => {
  const ui = dashboardFixture();
  assert.deepEqual(ui.messages, [{ type: "ready" }]);
  ui.receive(snapshot());
  assert.equal(ui.document.getElementById("today-value").textContent, "15m");
  assert.equal(ui.document.getElementById("goal-value").textContent, "25%");
  assert.equal(ui.document.querySelectorAll(".day-placeholder").length, 3);
  assert.equal(ui.date("2026-10-02").getAttribute("aria-current"), "date");
  assert.equal(ui.date("2026-10-02").getAttribute("aria-pressed"), "true");
  assert.equal(ui.date("2026-10-03").disabled, true);
  assert.equal(ui.date("2026-10-01").dataset.level, "3");
});

test("live updates preserve selected nodes and keyboard focus", () => {
  const ui = dashboardFixture();
  ui.receive(snapshot());
  const first = ui.date("2026-10-01");
  ui.document.getElementById("calendar").fire("click", first);
  first.focus();
  ui.receive(snapshot({ summary: { ...snapshot().summary, todaySeconds: 901 } }));
  assert.equal(ui.date("2026-10-01"), first);
  assert.equal(ui.document.activeElement, first);
  assert.equal(first.getAttribute("aria-pressed"), "true");
  assert.equal(ui.state.selectedDate, "2026-10-01");
});

test("keyboard dates cross month boundaries and year overview returns to today", () => {
  const ui = dashboardFixture();
  ui.receive(snapshot());
  ui.document.getElementById("calendar").fire("keydown", ui.date("2026-10-01"), { key: "ArrowLeft" });
  assert.equal(ui.state.selectedDate, "2026-09-30");
  assert.equal(ui.document.activeElement, ui.date("2026-09-30"));
  ui.click("year-view");
  assert.equal(ui.document.querySelectorAll("button[data-date]").length, 365);
  ui.click("today-button");
  assert.equal(ui.state.selectedDate, "2026-10-02");
  ui.click("month-view");
  assert.equal(ui.document.querySelectorAll("button[data-date]").length, 31);
});

test("restores navigation and project filter without silently losing the saved selection", () => {
  const ui = dashboardFixture({ selectedDate: "2026-09-15", viewedMonth: "2026-09-01", mode: "month", projectId: "app" });
  assert.deepEqual(ui.messages, [{ type: "ready" }, { type: "filter", projectId: "app" }]);
  ui.receive(snapshot({ projectId: "app" }));
  assert.equal(ui.state.selectedDate, "2026-09-15");
  assert.equal(ui.state.viewedMonth, "2026-09-01");
  assert.equal(ui.document.getElementById("project-filter").value, "app");
});

test("filenames and project names are rendered as text, with distinct files preserved", () => {
  const ui = dashboardFixture();
  const hostile = "<img src=x onerror=alert(1)>.js";
  ui.receive(snapshot({
    projects: [{ id: "app", name: "<svg onload=alert(1)>" }],
    days: { "2026-10-02": { time: 0, characters: 2, files: [
      { id: "app/a", path: hostile, projectId: "app", projectName: "<svg onload=alert(1)>" },
      { id: "app/b", path: "src/index.js", projectId: "app", projectName: "<svg onload=alert(1)>" },
      { id: "app/c", path: "test/index.js", projectId: "app", projectName: "<svg onload=alert(1)>" },
    ] } },
  }));
  const files = ui.document.getElementById("file-list");
  assert.ok(files.textContent.includes(hostile));
  assert.ok(files.textContent.includes("<svg onload=alert(1)>"));
  assert.equal(files.querySelectorAll("li").length, 3);
  assert.equal(files.querySelectorAll("img").length, 0);
  assert.equal(files.querySelectorAll("svg").length, 0);
  assert.equal(ui.date("2026-10-02").dataset.level, "0");
});

test("pause, settings, data actions and filters send only their expected messages", () => {
  const ui = dashboardFixture();
  ui.receive(snapshot());
  ui.click("pause-button");
  ui.click("settings-button");
  const filter = ui.document.getElementById("project-filter");
  filter.value = "app";
  filter.fire("change");
  const csv = ui.document.querySelector('button[data-action="exportCsv"]');
  csv.fire("click");
  assert.deepEqual(ui.messages.slice(1), [
    { type: "togglePause" }, { type: "settings" }, { type: "filter", projectId: "app" }, { type: "exportCsv" },
  ]);
});

test("midnight follows today while historical selections stay selected", () => {
  const ui = dashboardFixture();
  ui.receive(snapshot());
  ui.receive(snapshot({ today: "2026-10-03" }));
  assert.equal(ui.state.selectedDate, "2026-10-03");
  assert.equal(ui.date("2026-10-03").disabled, false);
  ui.document.getElementById("calendar").fire("click", ui.date("2026-10-01"));
  ui.receive(snapshot({ today: "2026-10-04" }));
  assert.equal(ui.state.selectedDate, "2026-10-01");
});

test("year month links become available after midnight even when viewing historical dates", () => {
  const ui = dashboardFixture({ selectedDate: "2026-01-01", viewedMonth: "2026-01-01", mode: "year" });
  ui.receive(snapshot({ today: "2026-10-31" }));
  const november = ui.document.querySelector('button[data-month="2026-11-01"]');
  assert.equal(november.disabled, true);
  ui.receive(snapshot({ today: "2026-11-01" }));
  assert.equal(november.disabled, false);
});

test("a disabled goal and changed week start are reflected without counting blank records", () => {
  const ui = dashboardFixture();
  ui.receive(snapshot({ weekStartsOn: 0, summary: { ...snapshot().summary, goalSeconds: 0 } }));
  assert.equal(ui.document.getElementById("goal-value").textContent, "Off");
  assert.equal(ui.document.getElementById("goal-progress").hidden, true);
  assert.equal(ui.document.querySelectorAll(".day-placeholder").length, 4);
});

test("webview uses external resources and a unique nonce under a restrictive CSP", () => {
  const first = webviewHTML();
  const second = webviewHTML();
  const nonce = first.match(/script-src 'nonce-([^']+)'/)[1];
  assert.notEqual(nonce, second.match(/script-src 'nonce-([^']+)'/)[1]);
  assert.ok(first.includes("default-src 'none'"));
  assert.ok(first.includes('nonce="' + nonce + '"'));
  assert.ok(first.includes("media/dashboard.js"));
  assert.ok(first.includes("media/dashboard.css"));
  assert.equal(/\son[a-z]+=/i.test(first), false);
  assert.equal(/unsafe-inline|https?:\/\//.test(first), false);
});
