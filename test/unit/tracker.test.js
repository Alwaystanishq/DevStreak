"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { ActiveTracker } = require("../../src/tracker");

function setup(options = {}) {
  let now = options.start ?? new Date(2026, 9, 2, 12).getTime();
  const changes = [];
  const tracker = new ActiveTracker({ onChange: (change) => changes.push(change), now: () => now, idleTimeoutMs: 10000, ...options });
  tracker.setContext({ focused: true, eligible: true, projectId: "project-a", projectName: "Project A" });
  return { tracker, changes, advance: (milliseconds) => { now += milliseconds; return now; }, total: () => changes.reduce((sum, change) => sum + change.seconds, 0) };
}

test("opening a focused eligible editor does not start tracking", () => {
  const { tracker, changes, advance } = setup();
  assert.equal(tracker.status(), "idle");
  advance(5000);
  tracker.tick();
  assert.deepEqual(changes, []);
  tracker.activity();
  assert.equal(tracker.status(), "tracking");
  advance(1250);
  tracker.tick();
  assert.equal(changes[0].seconds, 1.25);
});

test("idle cutoff is exact and repeated ticks do not count time twice", () => {
  const { tracker, advance, total } = setup();
  tracker.activity();
  advance(6000);
  tracker.tick();
  tracker.tick();
  advance(6000);
  tracker.tick();
  assert.equal(total(), 10);
  assert.equal(tracker.status(), "idle");
  advance(5000);
  tracker.tick();
  assert.equal(total(), 10);
  tracker.activity();
  advance(500);
  tracker.tick();
  assert.equal(total(), 10.5);
});

test("new activity extends the reading grace period", () => {
  const { tracker, advance, total } = setup();
  tracker.activity();
  advance(8000);
  tracker.activity();
  advance(8000);
  tracker.tick();
  assert.equal(total(), 16);
  assert.equal(tracker.status(), "tracking");
  advance(2000);
  tracker.tick();
  assert.equal(total(), 18);
  assert.equal(tracker.status(), "idle");
});

test("a focused window reported inactive rejects edits and time until it becomes active", () => {
  const { tracker, advance, total, changes } = setup();
  tracker.activity();
  advance(2000);
  tracker.setContext({ active: false });
  assert.equal(total(), 2);
  assert.equal(tracker.status(), "idle");
  advance(1000);
  tracker.activity();
  tracker.edit({ characters: 20, file: { id: "file:///a", path: "a.js" } });
  advance(1000);
  tracker.tick();
  assert.equal(total(), 2);
  assert.equal(changes.reduce((sum, change) => sum + change.characters, 0), 0);
  tracker.setContext({ active: true });
  advance(1000);
  tracker.tick();
  assert.equal(total(), 2);
  tracker.activity();
  advance(1000);
  tracker.tick();
  assert.equal(total(), 3);
});

test("an hour without input counts only the configured grace and never backfills idle time", () => {
  const { tracker, advance, total } = setup({ idleTimeoutMs: 300000 });
  tracker.activity();
  for (let i = 0; i < 3600; i++) {
    advance(1000);
    tracker.tick();
  }
  assert.equal(total(), 300);
  assert.equal(tracker.status(), "idle");
  tracker.activity();
  advance(1000);
  tracker.tick();
  assert.equal(total(), 301);
});

test("a long sleep gap is discarded until a new activity event", () => {
  const { tracker, advance, total } = setup({ idleTimeoutMs: 300000 });
  tracker.activity();
  advance(5000);
  tracker.tick();
  advance(3600000);
  assert.equal(tracker.status(), "idle");
  tracker.tick();
  assert.equal(total(), 5);
  advance(1000);
  tracker.tick();
  assert.equal(total(), 5);
  tracker.activity();
  advance(1000);
  tracker.tick();
  assert.equal(total(), 6);
});

test("clock rollback drops the interval without negative or duplicate time", () => {
  const { tracker, advance, total } = setup();
  tracker.activity();
  advance(2000);
  tracker.tick();
  advance(-10000);
  tracker.tick();
  assert.equal(total(), 2);
  assert.equal(tracker.status(), "idle");
  tracker.activity();
  advance(1000);
  tracker.tick();
  assert.equal(total(), 3);
});

test("focus changes settle the previous interval and require new activity", () => {
  const { tracker, advance, total, changes } = setup();
  tracker.activity();
  advance(2000);
  tracker.setContext({ focused: false });
  assert.equal(total(), 2);
  advance(1000);
  tracker.edit({ characters: 50, file: { id: "file:///a", path: "a.js" } });
  tracker.setContext({ focused: true });
  advance(1000);
  tracker.tick();
  assert.equal(total(), 2);
  assert.equal(changes.reduce((sum, change) => sum + change.characters, 0), 0);
  assert.equal(tracker.status(), "idle");
  tracker.activity();
  advance(1000);
  tracker.tick();
  assert.equal(total(), 3);
});

test("project changes settle time under the original project", () => {
  const { tracker, advance, changes } = setup();
  tracker.activity();
  advance(2500);
  tracker.setContext({ projectId: "project-b", projectName: "Project B" });
  assert.equal(tracker.status(), "idle");
  tracker.activity();
  advance(1500);
  tracker.tick();
  assert.deepEqual(changes.map(({ projectId, projectName, seconds }) => ({ projectId, projectName, seconds })), [
    { projectId: "project-a", projectName: "Project A", seconds: 2.5 },
    { projectId: "project-b", projectName: "Project B", seconds: 1.5 },
  ]);
});

test("repeating the current context preserves activity without extending its timeout", () => {
  const { tracker, advance, total } = setup();
  tracker.activity();
  advance(5000);
  tracker.setContext({ focused: true, eligible: true, projectId: "project-a", projectName: "Project A" });
  advance(5000);
  tracker.tick();
  assert.equal(total(), 10);
  assert.equal(tracker.status(), "idle");
});

test("ignored files and ineligible contexts do not record edits or time", () => {
  const { tracker, advance, changes } = setup();
  tracker.setContext({ eligible: false });
  tracker.activity();
  tracker.edit({ characters: 10, file: { id: "file:///ignored", path: "ignored.js" } });
  advance(1000);
  tracker.tick();
  assert.deepEqual(changes, []);
  assert.equal(tracker.status(), "idle");
});

test("pause settles time, rejects edits and resumes only after interaction", () => {
  const { tracker, advance, total, changes } = setup();
  tracker.activity();
  advance(1200);
  tracker.setPaused(true);
  assert.equal(total(), 1.2);
  assert.equal(tracker.status(), "paused");
  tracker.edit({ characters: 10, file: { id: "file:///a", path: "a.js" } });
  advance(2000);
  tracker.setPaused(false);
  assert.equal(tracker.status(), "idle");
  assert.equal(changes.length, 1);
  tracker.activity();
  advance(1000);
  tracker.tick();
  assert.equal(total(), 2.2);
});

test("edits record added characters and file identity separately from elapsed time", () => {
  const { tracker, advance, changes } = setup();
  tracker.edit({ characters: 5, file: { id: "file:///src/index.js", path: "src/index.js" } });
  advance(1000);
  tracker.edit({ characters: 0, file: { id: "file:///test/index.js", path: "test/index.js" } });
  assert.equal(changes.length, 3);
  assert.equal(changes[0].characters, 5);
  assert.equal(changes[0].seconds, 0);
  assert.equal(changes[1].seconds, 1);
  assert.equal(changes[1].file, undefined);
  assert.equal(changes[2].characters, 0);
  assert.equal(changes[2].file.path, "test/index.js");
});

test("intervals are split at local midnight and preserve fractional seconds", () => {
  const { tracker, advance, changes } = setup({ start: new Date(2026, 9, 1, 23, 59, 59, 750).getTime() });
  tracker.activity();
  advance(1000);
  tracker.tick();
  assert.deepEqual(changes.map(({ date, seconds }) => ({ date, seconds })), [
    { date: "2026-10-01", seconds: 0.25 },
    { date: "2026-10-02", seconds: 0.75 },
  ]);
});

test("local midnight boundaries follow 23-hour and 25-hour DST days", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    for (const [month, day, hours] of [[2, 8, 23], [10, 1, 25]]) {
      const { tracker, changes } = setup({ start: new Date(2026, month, day).getTime(), idleTimeoutMs: 48 * 3600000, maxGapMs: 48 * 3600000 });
      tracker.activity();
      tracker.tick(new Date(2026, month, day + 1, 0, 0, 1).getTime());
      assert.deepEqual(changes.map(({ seconds }) => seconds), [hours * 3600, 1]);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("tracking uses the OS timezone in fresh processes, including both DST changes", () => {
  const trackerPath = require.resolve("../../src/tracker");
  const script = `
    const { ActiveTracker } = require(${JSON.stringify(trackerPath)});
    const run = (start, end) => {
      const changes = [];
      const tracker = new ActiveTracker({ now: () => start, onChange: c => changes.push(c), idleTimeoutMs: 172800000, maxGapMs: 172800000 });
      tracker.setContext({ focused: true, eligible: true, projectId: 'p', projectName: 'Project' });
      tracker.activity();
      tracker.tick(end);
      return changes.map(({date, seconds}) => ({date, seconds}));
    };
    const result = process.env.TZ === 'Asia/Kolkata'
      ? run(Date.parse('2026-10-01T18:29:59Z'), Date.parse('2026-10-01T18:30:01Z'))
      : [run(new Date(2026, 2, 8).getTime(), new Date(2026, 2, 9).getTime()), run(new Date(2026, 10, 1).getTime(), new Date(2026, 10, 2).getTime())];
    process.stdout.write(JSON.stringify(result));
  `;
  const india = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: "Asia/Kolkata" }, encoding: "utf8" }));
  assert.deepEqual(india, [{ date: "2026-10-01", seconds: 1 }, { date: "2026-10-02", seconds: 1 }]);
  const newYork = JSON.parse(execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: "America/New_York" }, encoding: "utf8" }));
  assert.deepEqual(newYork, [[{ date: "2026-03-08", seconds: 82800 }], [{ date: "2026-11-01", seconds: 90000 }]]);
});

test("shortening idle timeout takes effect and extending it never revives an idle session", () => {
  const { tracker, advance, total } = setup();
  tracker.activity();
  advance(5000);
  tracker.configure({ idleTimeoutMs: 3000 });
  assert.equal(total(), 5);
  assert.equal(tracker.status(), "idle");
  tracker.configure({ idleTimeoutMs: 30000 });
  assert.equal(tracker.status(), "idle");
  advance(1000);
  tracker.tick();
  assert.equal(total(), 5);
});

test("tracker rejects invalid intervals, character counts and timestamps", () => {
  assert.throws(() => new ActiveTracker(), TypeError);
  assert.throws(() => setup({ idleTimeoutMs: 0 }), TypeError);
  assert.throws(() => setup({ maxGapMs: Infinity }), TypeError);
  const { tracker } = setup();
  assert.throws(() => tracker.tick(NaN), TypeError);
  assert.throws(() => tracker.tick(1e100), TypeError);
  assert.throws(() => tracker.edit({ characters: 1.5 }), TypeError);
  assert.throws(() => tracker.edit({ characters: -1 }), TypeError);
  assert.throws(() => tracker.edit({ file: { id: "", path: "index.js" } }), TypeError);
});
