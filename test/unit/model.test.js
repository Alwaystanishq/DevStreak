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
