"use strict";

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** @returns {import('./types').ActivityData} */
function emptyData() {
  return { version: 3, days: {} };
}

function localDateKey(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new TypeError("Expected a valid date.");
  }
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function isDateKey(key) {
  if (typeof key !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return year > 0 && date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function parseLocalDate(key) {
  if (!isDateKey(key)) throw new TypeError(`Invalid date: ${key}`);
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(0);
  // Noon stays on the requested calendar day across midnight DST transitions.
  date.setHours(12, 0, 0, 0);
  date.setFullYear(year, month - 1, day);
  return date;
}

function record(value, label, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key) || (fields && !fields.includes(key))) {
      throw new TypeError(`Unexpected field in ${label}: ${key}`);
    }
  }
  if (fields && fields.some((field) => !Object.hasOwn(value, field))) {
    throw new TypeError(`${label} is missing required fields.`);
  }
}

function text(value, label, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && !value.length)) {
    throw new TypeError(`${label} must be a${allowEmpty ? "" : " nonempty"} string.`);
  }
  return value;
}

function safeId(value, label) {
  text(value, label);
  if (UNSAFE_KEYS.has(value)) throw new TypeError(`Invalid ${label}.`);
  return value;
}

function quantity(value, label, integer = false) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
      value > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(value))) {
    throw new TypeError(`${label} must be a nonnegative ${integer ? "safe integer" : "finite number"}.`);
  }
  return value;
}

/** @returns {import('./types').ActivityData} */
function validateData(input) {
  record(input, "Backup", ["version", "days"]);
  if (![2, 3].includes(input.version)) throw new TypeError("Unsupported backup version.");
  record(input.days, "Days");
  const result = emptyData();
  for (const [date, day] of Object.entries(input.days)) {
    if (!isDateKey(date)) throw new TypeError(`Invalid activity date: ${date}`);
    record(day, "Day", ["projects"]);
    record(day.projects, "Projects");
    const projects = {};
    for (const [id, project] of Object.entries(day.projects)) {
      safeId(id, "project ID");
      record(project, "Project", ["name", "time", "characters", "files", ...(input.version === 3 ? ["languages"] : [])]);
      record(project.files, "Files");
      const files = {};
      for (const [fileId, path] of Object.entries(project.files)) {
        files[safeId(fileId, "file ID")] = text(path, "File path");
      }
      const time = quantity(project.time, "Time");
      const languages = input.version === 2 ? unknownLanguages(time) : validateLanguages(project.languages, time);
      projects[id] = {
        name: text(project.name, "Project name"),
        time,
        characters: quantity(project.characters, "Characters", true),
        files,
        languages,
      };
    }
    result.days[date] = { projects };
  }
  return result;
}

function unknownLanguages(time) {
  return time > 0 ? { unknown: time } : {};
}

function validateLanguages(input, time) {
  record(input, "Languages");
  const languages = {};
  let total = 0;
  for (const [id, seconds] of Object.entries(input)) {
    languages[safeId(id, "language ID")] = quantity(seconds, "Language time");
    total = quantity(total + seconds, "Total language time");
  }
  // Language buckets accumulate in a different order from the project total.
  const tolerance = Math.max(1, time) * 1e-9;
  if (Math.abs(total - time) > tolerance) throw new TypeError("Language times must add up to project time.");
  return languages;
}

function migrateLegacy(input) {
  const result = emptyData();
  if (!input || typeof input !== "object" || Array.isArray(input)) return result;
  for (const [date, day] of Object.entries(input)) {
    if (!isDateKey(date) || !day || typeof day !== "object" || Array.isArray(day)) continue;
    const time = typeof day.time === "number" && Number.isFinite(day.time) && day.time >= 0 && day.time <= Number.MAX_SAFE_INTEGER ? day.time : 0;
    const characters = Number.isSafeInteger(day.letters) && day.letters >= 0 ? day.letters : 0;
    const files = {};
    for (const name of Array.isArray(day.files) ? day.files : []) {
      if (typeof name === "string" && name.length) files[`legacy:${name}`] = name;
    }
    if (time || characters || Object.keys(files).length) {
      result.days[date] = { projects: { legacy: { name: "Earlier activity", time, characters, files, languages: unknownLanguages(time) } } };
    }
  }
  return result;
}

/** @param {import('./types').ActivityData} data
 * @param {import('./types').ActivityChange[]} changes
 * @returns {import('./types').ActivityData} */
function applyChanges(data, changes) {
  if (!Array.isArray(changes)) throw new TypeError("Changes must be an array.");
  if (data.version === 2) data = validateData(data);
  /** @type {import('./types').ActivityData} */
  const result = { version: 3, days: { ...data.days } };
  for (const change of changes) {
    if (!change || !isDateKey(change.date)) throw new TypeError("Invalid change date.");
    const id = safeId(change.projectId, "project ID");
    const name = text(change.projectName, "Project name");
    const seconds = quantity(change.seconds ?? 0, "Seconds");
    const characters = quantity(change.characters ?? 0, "Characters", true);
    const languageId = safeId(change.languageId ?? "unknown", "language ID");
    if (change.file) {
      safeId(change.file.id, "file ID");
      text(change.file.path, "File path");
    }
    if (!seconds && !characters && !change.file) continue;
    const day = result.days[change.date];
    const previous = day && Object.hasOwn(day.projects, id) ? day.projects[id] : { name, time: 0, characters: 0, files: {}, languages: {} };
    const project = {
      name,
      time: quantity(previous.time + seconds, "Total time"),
      characters: quantity(previous.characters + characters, "Total characters", true),
      files: { ...previous.files },
      languages: { ...(previous.languages ?? unknownLanguages(previous.time)) },
    };
    if (seconds > 0) {
      const previousSeconds = Object.hasOwn(project.languages, languageId) ? project.languages[languageId] : 0;
      project.languages[languageId] = quantity(previousSeconds + seconds, "Total language time");
    }
    if (change.file) project.files[change.file.id] = change.file.path;
    result.days[change.date] = { projects: { ...day?.projects, [id]: project } };
  }
  return result;
}

function shiftDate(key, offset) {
  if (!isDateKey(key)) throw new TypeError(`Invalid date: ${key}`);
  // These are calendar labels, not instants. Local timezone transitions can
  // skip an entire date, which must still remain addressable in imported data.
  const date = new Date(key + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + offset);
  return `${String(date.getUTCFullYear()).padStart(4, "0")}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function periodActivity(data, start, end, projectId, goalSeconds, names) {
  let totalSeconds = 0;
  let activeDays = 0;
  let goalDays = goalSeconds > 0 ? 0 : null;
  const projects = new Map();
  const languages = new Map();
  for (const [date, day] of Object.entries(data.days)) {
    if (date < start || date > end) continue;
    let daySeconds = 0;
    for (const [id, project] of Object.entries(day.projects)) {
      if (projectId && id !== projectId) continue;
      daySeconds += project.time;
      if (project.time > 0) projects.set(id, (projects.get(id) || 0) + project.time);
      for (const [languageId, seconds] of Object.entries(project.languages ?? unknownLanguages(project.time))) {
        if (seconds > 0) languages.set(languageId, (languages.get(languageId) || 0) + seconds);
      }
    }
    totalSeconds += daySeconds;
    if (daySeconds > 0) activeDays++;
    if (goalSeconds > 0 && daySeconds >= goalSeconds) goalDays++;
  }
  return {
    start, end, totalSeconds, activeDays,
    averageSeconds: activeDays ? totalSeconds / activeDays : 0,
    goalDays,
    languages: [...languages].map(([id, seconds]) => ({ id, seconds }))
      .sort((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id)),
    projects: [...projects].map(([id, seconds]) => ({ id, name: names.get(id), seconds }))
      .sort((a, b) => b.seconds - a.seconds || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
  };
}

/** @param {import('./types').ActivityDay} day
 * @param {string} projectId
 * @param {boolean} includeFiles
 * @param {import('./types').SummaryOptions['dayCache']} [cache]
 * @returns {import('./types').DaySummary} */
function daySummary(day, projectId, includeFiles, cache) {
  const key = `${projectId}:${includeFiles}`;
  const cached = cache?.get(day);
  if (cached?.has(key)) return cached.get(key);
  const result = { time: 0, characters: 0, files: [] };
  for (const [id, project] of Object.entries(day.projects)) {
    if (projectId && id !== projectId) continue;
    result.time += project.time;
    result.characters += project.characters;
    if (includeFiles) for (const [fileId, path] of Object.entries(project.files)) {
      result.files.push({ id: fileId, path, projectId: id, projectName: project.name });
    }
  }
  result.files.sort((a, b) => a.projectName.localeCompare(b.projectName) || a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
  if (cache) {
    const entries = cached || new Map();
    entries.set(key, result);
    cache.set(day, entries);
  }
  return result;
}

/** @param {import('./types').ActivityData} data
 * @param {import('./types').SummaryOptions} [options]
 * @returns {import('./types').SummaryResult} */
function summarize(data, options = {}) {
  const today = options.today || localDateKey();
  if (!isDateKey(today)) throw new TypeError(`Invalid date: ${today}`);
  const todayDate = new Date(today + "T12:00:00Z");
  const projectId = options.projectId || "";
  const dailyGoalMinutes = Number.isFinite(options.dailyGoalMinutes) && options.dailyGoalMinutes >= 0 ? options.dailyGoalMinutes : 60;
  const streakMinimumMinutes = Number.isFinite(options.streakMinimumMinutes) && options.streakMinimumMinutes > 0 ? options.streakMinimumMinutes : 15;
  const weekStartsOn = Number.isInteger(options.weekStartsOn) && options.weekStartsOn >= 0 && options.weekStartsOn <= 6 ? options.weekStartsOn : 1;
  const projects = new Map();
  const days = {};
  for (const date of Object.keys(data.days).sort()) {
    for (const [id, project] of Object.entries(data.days[date].projects)) {
      projects.set(id, project.name);
    }
    days[date] = daySummary(data.days[date], projectId,
      options.includeFilesForDate === undefined || options.includeFilesForDate === date, options.dayCache);
  }
  const qualifyingSeconds = streakMinimumMinutes * 60;
  const qualified = Object.keys(days).sort().filter((date) => date <= today && days[date].time >= qualifyingSeconds);
  const qualifiedSet = new Set(qualified);
  let longestStreak = 0;
  let run = 0;
  let previous;
  for (const date of qualified) {
    run = previous && shiftDate(previous, 1) === date ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = date;
  }
  let cursor = qualifiedSet.has(today) ? today : shiftDate(today, -1);
  let currentStreak = 0;
  while (qualifiedSet.has(cursor)) {
    currentStreak++;
    cursor = shiftDate(cursor, -1);
  }
  const weekStart = shiftDate(today, -((todayDate.getUTCDay() - weekStartsOn + 7) % 7));
  const goalSeconds = dailyGoalMinutes * 60;
  const week = periodActivity(data, weekStart, today, projectId, goalSeconds, projects);
  // Compare the same weekdays, rather than a partial week with seven full days.
  const comparison = periodActivity(data, shiftDate(weekStart, -7), shiftDate(today, -7), projectId, goalSeconds, projects);
  const month = periodActivity(data, today.slice(0, 7) + "-01", today, projectId, goalSeconds, projects);
  const changeSeconds = week.totalSeconds - comparison.totalSeconds;
  return {
    days,
    projects: [...projects].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    insights: {
      start: weekStart, end: today,
      comparisonStart: comparison.start, comparisonEnd: comparison.end,
      previousSeconds: comparison.totalSeconds,
      changeSeconds,
      changePercent: comparison.totalSeconds > 0 ? changeSeconds / comparison.totalSeconds * 100 : null,
      activeDays: week.activeDays, averageSeconds: week.averageSeconds, goalDays: week.goalDays,
    },
    breakdown: { week, month },
    summary: {
      todaySeconds: days[today]?.time || 0,
      weekSeconds: week.totalSeconds,
      currentStreak,
      longestStreak,
      goalSeconds,
      qualifyingSeconds,
    },
  };
}

/** Inclusive local calendar dates, compared with the preceding equal-length period.
 * @param {import('./types').ActivityData} data
 * @param {string} start
 * @param {string} end
 * @param {import('./types').SummaryOptions} [options]
 * @returns {import('./types').RangeReport} */
function summarizeRange(data, start, end, options = {}) {
  const today = options.today || localDateKey();
  if (!isDateKey(today) || !isDateKey(start) || !isDateKey(end) || start > end || end > today) {
    throw new TypeError('Choose valid dates in order, ending on or before today.');
  }
  const length = Math.round((Date.parse(end + 'T12:00:00Z') - Date.parse(start + 'T12:00:00Z')) / 86400000) + 1;
  const comparisonStart = shiftDate(start, -length);
  const comparisonEnd = shiftDate(start, -1);
  if (!isDateKey(comparisonStart) || !isDateKey(comparisonEnd)) {
    throw new TypeError('Choose a later start date so the comparison period stays within years 0001–9999.');
  }
  const names = new Map();
  for (const date of Object.keys(data.days).sort()) {
    for (const [id, project] of Object.entries(data.days[date].projects)) names.set(id, project.name);
  }
  const goal = (Number.isFinite(options.dailyGoalMinutes) && options.dailyGoalMinutes >= 0 ? options.dailyGoalMinutes : 60) * 60;
  const current = periodActivity(data, start, end, options.projectId || '', goal, names);
  const previous = periodActivity(data, comparisonStart, comparisonEnd, options.projectId || '', goal, names);
  const changeSeconds = current.totalSeconds - previous.totalSeconds;
  return { ...current, comparisonStart: previous.start, comparisonEnd: previous.end,
    previousSeconds: previous.totalSeconds, changeSeconds,
    changePercent: previous.totalSeconds ? changeSeconds / previous.totalSeconds * 100 : null };
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function csvCell(value) {
  let cell = String(value);
  // Spreadsheet programs may execute formulas even when a CSV field is quoted.
  if (/^[\s]*[=+@-]/.test(cell) || /^[\t\r\n]/.test(cell)) cell = `'${cell}`;
  return `"${cell.replace(/"/g, '""')}"`;
}

function toCsv(data) {
  const rows = [["Date", "Project", "Project ID", "Active seconds", "Characters added", "Files edited", "File paths", "Language active seconds"]];
  for (const date of Object.keys(data.days).sort()) {
    for (const id of Object.keys(data.days[date].projects).sort()) {
      const project = data.days[date].projects[id];
      const paths = Object.values(project.files).sort();
      rows.push([date, project.name, id, project.time, project.characters, paths.length, paths.join("\n"), JSON.stringify(project.languages ?? unknownLanguages(project.time))]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

module.exports = { emptyData, validateData, migrateLegacy, applyChanges, summarize, summarizeRange, isDateKey, localDateKey, parseLocalDate, formatDuration, toCsv };
