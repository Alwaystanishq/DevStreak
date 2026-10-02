"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { emptyData, validateData, migrateLegacy, applyChanges, summarize, localDateKey, parseLocalDate, formatDuration, toCsv } = require("../../src/model");

function change(date, seconds, extra = {}) {
  return { date, seconds, projectId: "file:///project", projectName: "Project", characters: 0, ...extra };
}

function inTimezone(timezone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = timezone;
  try { fn(); } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test("dates use the local day across India's UTC boundary", () => {
  inTimezone("Asia/Kolkata", () => {
    assert.equal(localDateKey(new Date("2026-10-01T20:00:00Z")), "2026-10-02");
    assert.equal(localDateKey(parseLocalDate("2026-10-02")), "2026-10-02");
    assert.equal(parseLocalDate("2026-10-02").getHours(), 12);
  });
});

test("date parsing rejects impossible dates and accepts leap days", () => {
  for (const key of ["2025-02-29", "2026-04-31", "2026-00-01", "2026-01-00", "2026-1-01", "0000-01-01", "not-a-date"]) {
    assert.throws(() => parseLocalDate(key), TypeError);
  }
  assert.equal(localDateKey(parseLocalDate("2024-02-29")), "2024-02-29");
});

test("date stepping keeps streaks continuous through DST", () => {
  inTimezone("America/New_York", () => {
    const data = applyChanges(emptyData(), [change("2026-03-07", 900), change("2026-03-08", 900), change("2026-03-09", 900)]);
    const result = summarize(data, { today: "2026-03-09" });
    assert.equal(result.summary.currentStreak, 3);
    assert.equal(result.summary.longestStreak, 3);
  });
});

test("legacy migration preserves original dates, deduplicates files and skips empty or malformed entries", () => {
  const original = {
    "2026-10-01": { time: 4.5, letters: 20, files: ["index.js", "index.js", "<script>.js", null] },
    "2026-10-02": { time: 0, letters: 0, files: [] },
    "2026-10-03": { time: -10, letters: "5", files: ["readme.md"] },
    "2026-02-30": { time: 500, letters: 4, files: [] },
    broken: null,
  };
  const result = migrateLegacy(original);
  assert.deepEqual(Object.keys(result.days), ["2026-10-01", "2026-10-03"]);
  assert.deepEqual(result.days["2026-10-01"].projects.legacy, {
    name: "Earlier activity", time: 4.5, characters: 20,
    languages: { unknown: 4.5 },
    files: { "legacy:index.js": "index.js", "legacy:<script>.js": "<script>.js" },
  });
  assert.equal(result.days["2026-10-03"].projects.legacy.time, 0);
  assert.deepEqual(validateData(result), result);
  assert.deepEqual(migrateLegacy(null), emptyData());
});

test("changes accumulate without mutating prior data and retain distinct files with the same basename", () => {
  const initial = emptyData();
  const first = applyChanges(initial, [change("2026-10-02", 0.25, { characters: 3, file: { id: "file:///project/src/index.js", path: "src/index.js" } })]);
  const second = applyChanges(first, [
    change("2026-10-02", 0.5, { file: { id: "file:///project/test/index.js", path: "test/index.js" } }),
    change("2026-10-02", 1.25, { characters: 8 }),
  ]);
  assert.deepEqual(initial, emptyData());
  assert.equal(first.days["2026-10-02"].projects["file:///project"].time, 0.25);
  assert.equal(Object.keys(first.days["2026-10-02"].projects["file:///project"].files).length, 1);
  const project = second.days["2026-10-02"].projects["file:///project"];
  assert.equal(project.time, 2);
  assert.equal(project.characters, 11);
  assert.equal(Object.keys(project.files).length, 2);
  assert.deepEqual(applyChanges(second, []), second);
  assert.deepEqual(applyChanges(emptyData(), [change("2026-10-02", 0)]), emptyData());
});

test("valid IDs which resemble inherited object methods do not use prototype values", () => {
  const result = applyChanges(emptyData(), [change("2026-10-02", 1, { projectId: "toString", file: { id: "hasOwnProperty", path: "index.js" } })]);
  assert.equal(result.days["2026-10-02"].projects.toString.time, 1);
  assert.deepEqual(validateData(result), result);
});

test("backup validation returns independent normalized data", () => {
  const input = applyChanges(emptyData(), [change("2026-10-02", 1.5, { characters: 2, file: { id: "file:///project/index.js", path: "index.js" } })]);
  const result = validateData(input);
  assert.deepEqual(result, input);
  result.days["2026-10-02"].projects["file:///project"].files.extra = "extra";
  assert.equal(input.days["2026-10-02"].projects["file:///project"].files.extra, undefined);
});

test("backup validation rejects malformed schemas, values and impossible dates", () => {
  const invalid = [null, [], {}, { version: 1, days: {} }, { version: 2, days: [] }, { version: 2, days: {}, surprise: true }, { version: 2, days: { "2026-02-30": { projects: {} } } }];
  for (const field of ["name", "time", "characters", "files"]) {
    const data = applyChanges(emptyData(), [change("2026-10-02", 1)]);
    delete data.days["2026-10-02"].projects["file:///project"][field];
    invalid.push(data);
  }
  for (const [field, value] of [["time", -1], ["time", Infinity], ["time", NaN], ["time", "5"], ["characters", 1.5], ["characters", Number.MAX_SAFE_INTEGER + 1], ["name", ""], ["files", []], ["files", { "file:///x": 9 }]]) {
    const data = applyChanges(emptyData(), [change("2026-10-02", 1)]);
    data.days["2026-10-02"].projects["file:///project"][field] = value;
    invalid.push(data);
  }
  for (const input of invalid) assert.throws(() => validateData(input), TypeError);
});

test("malicious object keys are rejected at every map level without prototype pollution", () => {
  const payloads = [
    '{"version":2,"days":{"__proto__":{}}}',
    '{"version":2,"days":{"2026-10-02":{"projects":{"constructor":{"name":"bad","time":1,"characters":1,"files":{}}}}}}',
    '{"version":2,"days":{"2026-10-02":{"projects":{"p":{"name":"bad","time":1,"characters":1,"files":{"__proto__":"bad"}}}}}}',
    '{"version":2,"days":{"2026-10-02":{"projects":{"prototype":{"name":"bad","time":1,"characters":1,"files":{}}}}}}',
  ];
  for (const payload of payloads) assert.throws(() => validateData(JSON.parse(payload)), TypeError);
  assert.throws(() => applyChanges(emptyData(), [change("2026-10-02", 1, { projectId: "__proto__" })]), TypeError);
  assert.throws(() => applyChanges(emptyData(), [change("2026-10-02", 1, { file: { id: "constructor", path: "index.js" } })]), TypeError);
  assert.equal({}.polluted, undefined);
});

test("streaks give today a grace period but require the configured minimum", () => {
  const data = applyChanges(emptyData(), [
    change("2026-09-27", 900), change("2026-09-28", 900), change("2026-09-29", 900),
    change("2026-09-30", 10), change("2026-10-01", 900), change("2026-10-02", 899),
    change("2026-10-03", 4000),
  ]);
  const result = summarize(data, { today: "2026-10-02", dailyGoalMinutes: 30 });
  assert.deepEqual(result.summary, { todaySeconds: 899, weekSeconds: 3609, currentStreak: 1, longestStreak: 3, goalSeconds: 1800, qualifyingSeconds: 900 });
  const qualifiedToday = summarize(applyChanges(data, [change("2026-10-02", 1)]), { today: "2026-10-02" });
  assert.equal(qualifiedToday.summary.currentStreak, 2);
  assert.equal(summarize(data, { today: "2026-10-05" }).summary.currentStreak, 0);
});

test("weekly totals respect the configured first weekday", () => {
  const data = applyChanges(emptyData(), [change("2026-09-27", 10), change("2026-09-28", 20), change("2026-10-02", 30), change("2026-10-03", 400)]);
  assert.equal(summarize(data, { today: "2026-10-02", weekStartsOn: 1 }).summary.weekSeconds, 50);
  assert.equal(summarize(data, { today: "2026-10-02", weekStartsOn: 0 }).summary.weekSeconds, 60);
});

test("a zero daily goal disables the goal without changing streak qualification", () => {
  const data = applyChanges(emptyData(), [change("2026-10-02", 900)]);
  const { summary } = summarize(data, { today: "2026-10-02", dailyGoalMinutes: 0 });
  assert.equal(summary.goalSeconds, 0);
  assert.equal(summary.qualifyingSeconds, 900);
  assert.equal(summary.currentStreak, 1);
});

test("weekly insights compare matching weekdays and average only days with active time", () => {
  const data = applyChanges(emptyData(), [
    change("2026-09-21", 1800), change("2026-09-25", 1800),
    change("2026-09-26", 90000), // Last week's Saturday is outside Friday's comparison.
    change("2026-09-28", 3600), change("2026-10-01", 1800), change("2026-10-02", 1800),
    change("2026-09-29", 0, { characters: 100 }),
    change("2026-10-03", 90000), // Future activity is excluded.
  ]);
  const { insights, breakdown } = summarize(data, { today: "2026-10-02" });
  assert.deepEqual(insights, {
    start: "2026-09-28", end: "2026-10-02", comparisonStart: "2026-09-21", comparisonEnd: "2026-09-25",
    previousSeconds: 3600, changeSeconds: 3600, changePercent: 100,
    activeDays: 3, averageSeconds: 2400, goalDays: 1,
  });
  assert.equal(breakdown.week.totalSeconds, 7200);
  assert.equal(breakdown.month.start, "2026-10-01");
  assert.equal(breakdown.month.totalSeconds, 3600);
});

test("insights distinguish an empty baseline, a decrease, and a disabled goal", () => {
  const empty = summarize(emptyData(), { today: "2026-10-02", dailyGoalMinutes: 0 });
  assert.equal(empty.insights.changePercent, null);
  assert.equal(empty.insights.averageSeconds, 0);
  assert.equal(empty.insights.goalDays, null);
  assert.deepEqual(empty.breakdown.week.projects, []);
  const data = applyChanges(emptyData(), [change("2026-09-25", 7200), change("2026-10-02", 3600)]);
  const result = summarize(data, { today: "2026-10-02" });
  assert.equal(result.insights.changePercent, -50);
  assert.equal(result.insights.changeSeconds, -3600);
  assert.equal(result.insights.goalDays, 1);
  const none = summarize(data, { today: "2026-10-02", projectId: "missing" });
  assert.equal(none.insights.activeDays, 0);
  assert.equal(none.insights.changePercent, null);
  assert.deepEqual(none.breakdown.month.projects, []);
});

test("project breakdowns sort by duration, retain separate project IDs, and follow filters", () => {
  const data = applyChanges(emptyData(), [
    change("2026-09-28", 4000), change("2026-10-02", 1000),
    change("2026-10-02", 2000, { projectId: "other", projectName: "Project" }),
    change("2026-10-01", 2000, { projectId: "another", projectName: "Another" }),
    change("2026-10-02", 0, { projectId: "edits", projectName: "Edits only", characters: 2 }),
  ]);
  const result = summarize(data, { today: "2026-10-02" });
  assert.deepEqual(result.breakdown.week.projects, [
    { id: "file:///project", name: "Project", seconds: 5000 },
    { id: "another", name: "Another", seconds: 2000 },
    { id: "other", name: "Project", seconds: 2000 },
  ]);
  assert.deepEqual(result.breakdown.month.projects.map((project) => project.seconds), [2000, 2000, 1000]);
  const filtered = summarize(data, { today: "2026-10-02", projectId: "other", dailyGoalMinutes: 30 });
  assert.equal(filtered.insights.averageSeconds, 2000);
  assert.equal(filtered.insights.goalDays, 1);
  assert.equal(filtered.breakdown.week.totalSeconds, 2000);
  assert.deepEqual(filtered.breakdown.week.projects, [{ id: "other", name: "Project", seconds: 2000 }]);
  assert.equal(filtered.projects.length, 4);
});

test("weekly comparisons respect Sunday starts and local DST calendar boundaries", () => {
  inTimezone("America/New_York", () => {
    const data = applyChanges(emptyData(), [
      change("2026-03-01", 60), change("2026-03-02", 60), change("2026-03-03", 600),
      change("2026-03-08", 120), change("2026-03-09", 120),
    ]);
    const { insights } = summarize(data, { today: "2026-03-09", weekStartsOn: 0 });
    assert.equal(insights.start, "2026-03-08");
    assert.equal(insights.comparisonStart, "2026-03-01");
    assert.equal(insights.comparisonEnd, "2026-03-02");
    assert.equal(insights.changePercent, 100);
  });
});

test("breakdown date ranges cross years and preserve subsecond activity", () => {
  const data = applyChanges(emptyData(), [change("2025-12-25", 0.25), change("2025-12-29", 1), change("2026-01-01", 0.5)]);
  const { insights, breakdown } = summarize(data, { today: "2026-01-01" });
  assert.equal(insights.start, "2025-12-29");
  assert.equal(insights.comparisonEnd, "2025-12-25");
  assert.equal(insights.changePercent, 500);
  assert.equal(breakdown.week.totalSeconds, 1.5);
  assert.equal(breakdown.month.totalSeconds, 0.5);
  assert.equal(breakdown.month.projects[0].seconds, 0.5);
});

test("project filters affect every metric while keeping all available projects", () => {
  const data = applyChanges(emptyData(), [
    change("2026-10-01", 1000, { file: { id: "file:///project/index.js", path: "index.js" } }),
    change("2026-10-02", 1000),
    change("2026-10-02", 100, { projectId: "other", projectName: "Other", characters: 40, file: { id: "file:///other/index.js", path: "index.js" } }),
  ]);
  const result = summarize(data, { today: "2026-10-02", projectId: "other" });
  assert.equal(result.summary.todaySeconds, 100);
  assert.equal(result.summary.weekSeconds, 100);
  assert.equal(result.summary.currentStreak, 0);
  assert.equal(result.summary.longestStreak, 0);
  assert.equal(result.projects.length, 2);
  assert.deepEqual(result.days["2026-10-02"].files, [{ id: "file:///other/index.js", path: "index.js", projectId: "other", projectName: "Other" }]);
});

test("CSV escapes quotes, multiline paths and formula-like values", () => {
  const data = applyChanges(emptyData(), [change("2026-10-02", 5.5, { projectId: "=IMPORTXML()", projectName: '@SUM("1")', characters: 3, file: { id: "file:///x", path: "=HYPERLINK()\nnext\"file" } })]);
  const csv = toCsv(data);
  assert.match(csv, /"'@SUM\(""1""\)"/);
  assert.match(csv, /"'=IMPORTXML\(\)"/);
  assert.match(csv, /"'=HYPERLINK\(\)\nnext""file"/);
  assert.match(csv, /"5\.5","3","1"/);
  assert.ok(csv.endsWith("\r\n"));
});

test("duration formatting floors subsecond totals and permits long sessions", () => {
  assert.equal(formatDuration(3661.9), "01:01:01");
  assert.equal(formatDuration(360000), "100:00:00");
  assert.equal(formatDuration(-1), "00:00:00");
  assert.equal(formatDuration(NaN), "00:00:00");
});

test("version-2 backups migrate to unknown language without guessing from filenames", () => {
  const old = { version: 2, days: { "2026-10-02": { projects: {
    app: { name: "App", time: 12.5, characters: 3, files: { "file:///x.py": "x.py" } },
    edits: { name: "Edits", time: 0, characters: 1, files: {} },
  } } } };
  const original = structuredClone(old);
  const migrated = validateData(old);
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.days["2026-10-02"].projects.app.languages, { unknown: 12.5 });
  assert.deepEqual(migrated.days["2026-10-02"].projects.edits.languages, {});
  assert.deepEqual(old, original);
  assert.deepEqual(validateData(migrated), migrated);
  const updated = applyChanges(old, [change("2026-10-02", 2, { projectId: "app", languageId: "python" })]);
  assert.deepEqual(updated.days["2026-10-02"].projects.app.languages, { unknown: 12.5, python: 2 });
  assert.deepEqual(validateData(updated), updated);
});

test("language changes preserve prior buckets and edits without time add no language duration", () => {
  const first = applyChanges(emptyData(), [change("2026-10-02", 0.1, { languageId: "javascript" })]);
  const next = applyChanges(first, [
    change("2026-10-02", 0.2, { languageId: "python" }),
    change("2026-10-02", 0, { languageId: "markdown", characters: 100 }),
    change("2026-10-02", 0.3, { languageId: "toString" }),
  ]);
  const project = next.days["2026-10-02"].projects["file:///project"];
  assert.deepEqual(project.languages, { javascript: 0.1, python: 0.2, toString: 0.3 });
  assert.deepEqual(first.days["2026-10-02"].projects["file:///project"].languages, { javascript: 0.1 });
  assert.deepEqual(validateData(JSON.parse(JSON.stringify(next))), next);
  const normalized = validateData(next);
  normalized.days["2026-10-02"].projects["file:///project"].languages.python = 10;
  assert.equal(project.languages.python, 0.2);
});

test("language validation rejects missing, malformed, unsafe and inconsistent buckets", () => {
  for (const languages of [undefined, [], null, { python: -1 }, { python: NaN }, { python: Infinity }, { python: "1" }, { python: 2 }, {}, { "": 1 }, JSON.parse('{"__proto__":1}'), { constructor: 1 }]) {
    const data = applyChanges(emptyData(), [change("2026-10-02", 1)]);
    data.days["2026-10-02"].projects["file:///project"].languages = languages;
    assert.throws(() => validateData(data), TypeError);
  }
  const missing = applyChanges(emptyData(), [change("2026-10-02", 1)]);
  delete missing.days["2026-10-02"].projects["file:///project"].languages;
  assert.throws(() => validateData(missing), TypeError);
  for (const languageId of ["__proto__", "constructor", "prototype", "", 3]) {
    assert.throws(() => applyChanges(emptyData(), [change("2026-10-02", 1, { languageId })]), TypeError);
  }
});

test("language breakdowns aggregate by ID, sort ties, and respect project and period filters", () => {
  const data = applyChanges(emptyData(), [
    change("2026-09-27", 100, { languageId: "rust" }),
    change("2026-09-28", 60, { languageId: "javascript" }),
    change("2026-10-01", 30, { languageId: "python" }),
    change("2026-10-02", 30, { projectId: "docs", languageId: "python" }),
    change("2026-10-02", 20),
    change("2026-10-03", 1000, { languageId: "go" }),
  ]);
  const result = summarize(data, { today: "2026-10-02" });
  assert.deepEqual(result.breakdown.week.languages, [
    { id: "javascript", seconds: 60 }, { id: "python", seconds: 60 }, { id: "unknown", seconds: 20 },
  ]);
  assert.deepEqual(result.breakdown.month.languages, [{ id: "python", seconds: 60 }, { id: "unknown", seconds: 20 }]);
  assert.equal(result.breakdown.week.languages.reduce((sum, row) => sum + row.seconds, 0), result.breakdown.week.totalSeconds);
  const filtered = summarize(data, { today: "2026-10-02", projectId: "docs" });
  assert.deepEqual(filtered.breakdown.week.languages, [{ id: "python", seconds: 30 }]);
  assert.deepEqual(summarize(data, { today: "2026-10-02", projectId: "missing" }).breakdown.week.languages, []);
  assert.equal(summarize(data, { today: "2026-10-02", weekStartsOn: 0 }).breakdown.week.languages[0].id, "rust");
});

test("CSV includes language durations without changing its date/project row grouping", () => {
  const data = applyChanges(emptyData(), [
    change("2026-10-02", 2, { languageId: "javascript" }),
    change("2026-10-02", 3, { languageId: "python" }),
  ]);
  const csv = toCsv(data);
  assert.ok(csv.includes('"Language active seconds"'));
  assert.ok(csv.includes('"{""javascript"":2,""python"":3}"'));
  assert.equal(csv.split("\r\n").length, 3);
});
