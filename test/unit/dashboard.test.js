const test = require("node:test");
const assert = require("node:assert/strict");
const { dashboardFixture, webviewHTML } = require("../helpers/dashboard-fixture");
const { emptyData, applyChanges, summarize } = require("../../src/model");

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

function activitySnapshot(changes = [], options = {}) {
  const data = applyChanges(emptyData(), changes.map(([date, seconds, projectId = "app", projectName = "app", languageId]) =>
    ({ date, seconds, projectId, projectName, languageId })));
  return snapshot({ ...summarize(data, { today: "2026-10-02", ...options }), projectId: options.projectId || "" });
}

test("weekly insights and project shares render live model calculations", () => {
  const ui = dashboardFixture();
  ui.receive(activitySnapshot([
    ["2026-09-25", 1800], ["2026-09-28", 3600], ["2026-10-02", 1800, "docs", "Docs"],
  ]));
  assert.equal(ui.document.getElementById("week-change").textContent, "200% more");
  assert.equal(ui.document.getElementById("week-comparison").textContent, "1h 0m more active time");
  assert.equal(ui.document.getElementById("week-average").textContent, "45m");
  assert.equal(ui.document.getElementById("week-active-days").textContent, "2 active days this week");
  assert.equal(ui.document.getElementById("week-goal-days").textContent, "1 day");
  const rows = ui.document.querySelectorAll(".project-time-row");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes("1h 0m · 66.7%"));
  assert.equal(rows[0].querySelector("meter").value, 3600);
  assert.equal(rows[0].querySelector("meter").max, 5400);
  assert.equal(rows[0].querySelector("meter").getAttribute("aria-valuetext"), "1h 0m, 66.7% of active time");
  assert.ok(ui.document.getElementById("insights-note").textContent.includes("Sep 21, 2026 – Sep 25, 2026"));
});

test("project period switching restores selection and uses distinct week and month totals", () => {
  const ui = dashboardFixture({ breakdownPeriod: "month" });
  const data = activitySnapshot([["2026-09-28", 3600], ["2026-10-02", 1800, "docs", "Docs"]]);
  ui.receive(data);
  assert.equal(ui.document.getElementById("breakdown-month").getAttribute("aria-pressed"), "true");
  assert.equal(ui.document.querySelectorAll(".project-time-row").length, 1);
  assert.ok(ui.document.getElementById("breakdown-total").textContent.startsWith("30m total"));
  ui.click("breakdown-week");
  assert.equal(ui.state.breakdownPeriod, "week");
  assert.equal(ui.document.querySelectorAll(".project-time-row").length, 2);
  assert.ok(ui.document.getElementById("breakdown-total").textContent.startsWith("1h 30m total"));
  assert.deepEqual(ui.messages, [{ type: "ready" }]);
  const first = ui.document.querySelector(".project-time-row");
  ui.receive(data);
  assert.equal(ui.document.querySelector(".project-time-row"), first);
});

test("empty analytics, disabled goals, decreases and filter changes display accurately", () => {
  const ui = dashboardFixture();
  ui.receive(activitySnapshot([], { dailyGoalMinutes: 0 }));
  assert.equal(ui.document.getElementById("week-change").textContent, "No baseline");
  assert.equal(ui.document.getElementById("week-average").textContent, "0m");
  assert.equal(ui.document.getElementById("week-goal-days").textContent, "Off");
  assert.equal(ui.document.getElementById("breakdown-empty").hidden, false);
  const changes = [["2026-09-25", 3600], ["2026-10-02", 1800], ["2026-10-02", 3600, "docs", "Docs"]];
  ui.receive(activitySnapshot(changes, { projectId: "app" }));
  assert.equal(ui.document.getElementById("week-change").textContent, "50% less");
  assert.equal(ui.document.getElementById("week-average").textContent, "30m");
  assert.equal(ui.document.getElementById("breakdown-empty").hidden, true);
  assert.equal(ui.document.querySelectorAll(".project-time-row").length, 1);
  assert.ok(ui.document.querySelector(".project-time-row").textContent.includes("100%"));
  assert.ok(ui.document.getElementById("insights-context").textContent.endsWith("· app"));
  ui.receive(activitySnapshot(changes, { projectId: "docs" }));
  assert.equal(ui.document.getElementById("week-change").textContent, "No baseline");
  assert.ok(ui.document.querySelector(".project-time-row").textContent.includes("Docs"));
});

test("project chart treats hostile names as text and preserves subsecond shares", () => {
  const ui = dashboardFixture();
  const name = "<img src=x onerror=alert(1)>";
  ui.receive(activitySnapshot([["2026-10-02", 0.5, "app", name]]));
  const chart = ui.document.getElementById("project-breakdown");
  assert.ok(chart.textContent.includes(name));
  assert.ok(chart.textContent.includes("<1s · 100%"));
  assert.equal(chart.querySelectorAll("img").length, 0);
  assert.equal(chart.querySelector("meter").max, 0.5);
  assert.equal(ui.document.getElementById("week-average").textContent, "<1s");
});

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

test("language chart shows sorted durations, shares and accessible meters", () => {
  const ui = dashboardFixture();
  const data = activitySnapshot([
    ["2026-10-02", 120, "app", "app", "javascript"],
    ["2026-10-02", 60, "app", "app", "python"],
  ]);
  ui.receive(data);
  const rows = ui.document.querySelectorAll(".language-time-row");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].textContent.includes("JavaScript2m · 66.7%"));
  assert.ok(rows[1].textContent.includes("Python1m · 33.3%"));
  assert.equal(rows[0].querySelector("meter").value, 120);
  assert.equal(rows[0].querySelector("meter").max, 180);
  assert.equal(rows[0].querySelector("meter").getAttribute("aria-label"), "JavaScript active time");
  assert.equal(rows[0].querySelector("meter").getAttribute("aria-valuetext"), "2m, 66.7% of active time");
  assert.equal(ui.document.getElementById("language-note").hidden, true);
  ui.receive(data);
  assert.equal(ui.document.querySelector(".language-time-row"), rows[0]);
});

test("language period restores independently and follows project filters and history clearing", () => {
  const ui = dashboardFixture({ languagePeriod: "month", breakdownPeriod: "week" });
  const changes = [
    ["2026-09-28", 60, "app", "app", "javascript"],
    ["2026-10-02", 120, "docs", "Docs", "markdown"],
  ];
  ui.receive(activitySnapshot(changes));
  assert.equal(ui.document.getElementById("language-month").getAttribute("aria-pressed"), "true");
  assert.equal(ui.document.getElementById("breakdown-week").getAttribute("aria-pressed"), "true");
  assert.equal(ui.document.querySelectorAll(".language-time-row").length, 1);
  ui.click("language-week");
  assert.equal(ui.state.languagePeriod, "week");
  assert.equal(ui.state.breakdownPeriod, "week");
  assert.equal(ui.document.querySelectorAll(".language-time-row").length, 2);
  ui.receive(activitySnapshot(changes, { projectId: "app" }));
  assert.equal(ui.document.querySelectorAll(".language-time-row").length, 1);
  assert.ok(ui.document.getElementById("language-context").textContent.endsWith("· app"));
  assert.ok(ui.document.querySelector(".language-time-row").textContent.includes("100%"));
  ui.receive(activitySnapshot());
  assert.equal(ui.document.getElementById("language-empty").hidden, false);
  assert.equal(ui.document.querySelectorAll(".language-time-row").length, 0);
  assert.deepEqual(ui.messages, [{ type: "ready" }]);
});

test("unknown and custom languages render safely with fractional shares", () => {
  const ui = dashboardFixture();
  const hostile = "<img src=x onerror=alert(1)>";
  ui.receive(activitySnapshot([
    ["2026-10-02", 0.5], ["2026-10-02", 0.5, "app", "app", hostile],
  ]));
  const chart = ui.document.getElementById("language-breakdown");
  assert.ok(chart.textContent.includes("Unknown language"));
  assert.ok(chart.textContent.includes(hostile));
  assert.ok(chart.textContent.includes("<1s · 50%"));
  assert.equal(chart.querySelectorAll("img").length, 0);
  assert.equal(ui.document.getElementById("language-note").hidden, false);
  ui.receive(activitySnapshot([["2026-10-02", 1, "app", "app", "my-dsl"]]));
  assert.ok(chart.textContent.includes("my-dsl"));
  assert.equal(ui.document.getElementById("language-note").hidden, true);
});

test("fractional time is retained for calendar totals, streak thresholds, and goal completion", () => {
  const ui = dashboardFixture({ mode: "year" });
  const data = activitySnapshot([["2026-10-01", 0.8], ["2026-10-02", 60.5]], {
    dailyGoalMinutes: 1.01, streakMinimumMinutes: 1.01,
  });
  ui.receive(data);
  assert.equal(ui.document.getElementById("goal-value").textContent, "99%");
  assert.equal(ui.document.getElementById("day-badge").hidden, true);
  assert.equal(ui.date("2026-10-02").dataset.level, "1");
  assert.equal(ui.date("2026-10-01").dataset.level, "1");
  const october = ui.document.querySelector('button[data-month="2026-10-01"]').parentElement;
  assert.equal(october.querySelector(".mini-month-total").textContent, "1m");
  const small = activitySnapshot([["2026-10-01", 0.8], ["2026-10-02", 0.8]]);
  ui.receive(small);
  assert.equal(october.querySelector(".mini-month-total").textContent, "1s");
});

test("calendar labels survive a skipped local date and years below 100", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Pacific/Apia";
  try {
    const ui = dashboardFixture();
    ui.receive(snapshot({ today: "2011-12-31", days: {}, selectedDate: "2011-12-30" }));
    ui.document.getElementById("calendar").fire("click", ui.date("2011-12-30"));
    assert.equal(ui.state.selectedDate, "2011-12-30");
    assert.equal(ui.document.querySelectorAll("button[data-date]").length, 31);
    assert.ok(ui.document.getElementById("selected-day-title").textContent.includes("30"));
    const early = dashboardFixture({ viewedMonth: "0099-12-01", selectedDate: "0099-12-31" });
    early.receive(snapshot());
    assert.ok(early.date("0099-12-31"));
    early.document.getElementById("calendar").fire("keydown", early.date("0099-12-31"), { key: "ArrowRight" });
    assert.equal(early.state.selectedDate, "0100-01-01");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("calendar totals exclude future activity and navigation respects the earliest supported date", () => {
  const ui = dashboardFixture({ mode: "year" });
  ui.receive(activitySnapshot([["2026-10-02", 60], ["2026-10-03", 3600]]));
  const october = ui.document.querySelector('button[data-month="2026-10-01"]').parentElement;
  assert.equal(october.querySelector(".mini-month-total").textContent, "1m");
  const early = dashboardFixture({ viewedMonth: "0001-01-01", selectedDate: "0001-01-01" });
  early.receive(snapshot());
  assert.equal(early.document.getElementById("previous-period").disabled, true);
  early.click("previous-period");
  assert.equal(early.state.viewedMonth, "0001-01-01");
  early.document.getElementById("calendar").fire("keydown", early.date("0001-01-01"), { key: "ArrowLeft" });
  assert.equal(early.state.selectedDate, "0001-01-01");
});

test("report form rejects invalid comparisons and restores only supported ranges", () => {
  const ui = dashboardFixture({ reportStart: "0001-01-01", reportEnd: "2026-10-02" });
  ui.receive(snapshot());
  assert.deepEqual(ui.messages, [{ type: "ready" }]);
  const start = ui.document.getElementById("report-start");
  const end = ui.document.getElementById("report-end");
  start.value = "0001-01-01";
  end.value = "2026-10-02";
  ui.document.getElementById("report-form").fire("submit");
  assert.equal(ui.document.getElementById("report-error").hidden, false);
  assert.deepEqual(ui.messages, [{ type: "ready" }]);
  start.value = "2026-09-30";
  ui.document.getElementById("report-form").fire("submit");
  assert.equal(ui.document.getElementById("report-error").hidden, true);
  assert.deepEqual(ui.messages.at(-1), { type: "report", start: "2026-09-30", end: "2026-10-02" });
  const restored = dashboardFixture({ reportStart: "2026-09-30", reportEnd: "2026-10-02" });
  restored.receive(snapshot());
  assert.deepEqual(restored.messages.at(-1), { type: "report", start: "2026-09-30", end: "2026-10-02" });
});

test("activity trends include inactive days and fractional time with an equal preceding period", () => {
  const ui = dashboardFixture({ trendPeriod: 7 });
  ui.receive(activitySnapshot([["2026-09-25", 60], ["2026-09-26", 0.5], ["2026-10-02", 120], ["2026-10-03", 10000]]));
  assert.equal(ui.document.getElementById("trend-total").textContent, "2m 0s");
  assert.equal(ui.document.getElementById("trend-average").textContent, "17s");
  assert.equal(ui.document.getElementById("trend-active-days").textContent, "2 / 7");
  assert.equal(ui.document.getElementById("trend-change").textContent, "100.8% more");
  assert.equal(ui.document.querySelectorAll(".trend-bar").length, 7);
  const chart = ui.document.getElementById("trend-chart");
  assert.equal(chart.querySelector('rect[data-date="2026-09-26"]').getAttribute("height"), "2");
  assert.equal(chart.querySelector('rect[data-date="2026-09-27"]').getAttribute("height"), "0");
  assert.equal(chart.querySelector('rect[data-date="2026-10-02"]').getAttribute("height"), "180");
  assert.equal(ui.document.getElementById("trend-table-body").children.length, 7);
  assert.ok(ui.document.getElementById("trend-table-body").textContent.includes("<1s"));
  assert.equal(ui.document.getElementById("trend-empty").hidden, true);
  assert.ok(chart.querySelector("svg").getAttribute("aria-label").includes("7 days"));
  ui.receive(activitySnapshot([["2026-09-25", 60]]));
  assert.equal(ui.document.getElementById("trend-change").textContent, "100% less");
});

test("trend periods switch, persist, restore, and keep unchanged chart nodes", () => {
  const ui = dashboardFixture();
  ui.receive(snapshot());
  assert.equal(ui.document.querySelectorAll(".trend-bar").length, 30);
  ui.click("trend-7");
  assert.equal(ui.state.trendPeriod, 7);
  assert.equal(ui.document.getElementById("trend-7").getAttribute("aria-pressed"), "true");
  assert.equal(ui.document.querySelectorAll(".trend-bar").length, 7);
  const chart = ui.document.getElementById("trend-chart").querySelector("svg");
  ui.receive(snapshot());
  assert.equal(ui.document.getElementById("trend-chart").querySelector("svg"), chart);
  ui.click("trend-90");
  const restored = dashboardFixture(ui.state);
  restored.receive(snapshot());
  assert.equal(restored.document.querySelectorAll(".trend-bar").length, 90);
  assert.equal(restored.document.getElementById("trend-90").getAttribute("aria-pressed"), "true");
  assert.deepEqual(ui.messages, [{ type: "ready" }]);
});

test("trends follow project filters, empty history, and midnight without changing the selected period", () => {
  const ui = dashboardFixture({ trendPeriod: 7 });
  const changes = [["2026-10-02", 60], ["2026-10-02", 120, "docs", "Docs"]];
  ui.receive(activitySnapshot(changes, { projectId: "docs" }));
  assert.equal(ui.document.getElementById("trend-total").textContent, "2m 0s");
  assert.ok(ui.document.getElementById("trend-context").textContent.endsWith("· Docs"));
  ui.receive(activitySnapshot(changes, { projectId: "app" }));
  assert.equal(ui.document.getElementById("trend-total").textContent, "1m 0s");
  ui.receive(snapshot({ today: "2026-10-03", days: {} }));
  assert.equal(ui.document.querySelectorAll(".trend-bar")[0].dataset.date, "2026-09-27");
  assert.equal(ui.document.querySelectorAll(".trend-bar").at(-1).dataset.date, "2026-10-03");
  assert.equal(ui.document.getElementById("trend-empty").hidden, false);
  assert.equal(ui.document.getElementById("trend-change").textContent, "No baseline");
  assert.equal(ui.state.trendPeriod, 7);
  assert.ok(ui.document.querySelectorAll(".trend-bar").every((bar) => bar.getAttribute("height") === "0"));
});

test("trend dates remain aligned across daylight-saving transitions", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const ui = dashboardFixture({ trendPeriod: 7 });
    ui.receive(snapshot({ today: "2026-03-10", days: { "2026-03-08": { time: 60, characters: 0, files: [] } } }));
    const bars = ui.document.querySelectorAll(".trend-bar");
    assert.deepEqual(bars.map((bar) => bar.dataset.date), ["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09", "2026-03-10"]);
    assert.equal(ui.document.getElementById("trend-total").textContent, "1m 0s");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
