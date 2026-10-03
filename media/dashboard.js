/* global acquireVsCodeApi, document, window */
(() => {
  "use strict";

  // Host contract: ready/filter/togglePause/settings/exportJson/exportCsv/importJson/
  // clearHistory go out; complete, project-filtered `snapshot` messages come in.
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const state = {
    selectedDate: isDateKey(saved.selectedDate) ? saved.selectedDate : "",
    viewedMonth: isDateKey(saved.viewedMonth) ? saved.viewedMonth.slice(0, 7) + "-01" : "",
    mode: saved.mode === "year" ? "year" : "month",
    projectId: typeof saved.projectId === "string" ? saved.projectId : "",
    breakdownPeriod: saved.breakdownPeriod === "month" ? "month" : "week",
    languagePeriod: saved.languagePeriod === "month" ? "month" : "week",
    reportStart: isDateKey(saved.reportStart) ? saved.reportStart : "",
    reportEnd: isDateKey(saved.reportEnd) ? saved.reportEnd : "",
  };
  /** @type {import('../src/types').DashboardSnapshot} */
  let snapshot;
  let calendarKey = "";
  let projectsKey = "";
  let filesKey = "";
  let breakdownKey = "";
  let languageKey = "";
  let reportKey = "";
  let revision = 0;
  let requestedDate = "";
  let restoredReport = false;
  const dateButtons = new Map();
  const monthTotals = new Map();
  /** @template {string & keyof import('../src/types').DashboardElements} K
   * @param {K} id
   * @returns {import('../src/types').DashboardElements[K]} */
  const byId = (id) => /** @type {import('../src/types').DashboardElements[K]} */ (document.getElementById(id));
  const fullDateFormatter = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const monthFormatter = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
  const numberFormatter = new Intl.NumberFormat();
  const percentFormatter = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 });
  const shortDateFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

  /** @param {unknown} value
   * @returns {value is string} */
  function isDateKey(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value + "T12:00:00");
    return Number.isFinite(date.getTime()) && dateKey(date) === value;
  }

  function dateKey(date) {
    return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }

  function parseDate(key) { return new Date(key + "T12:00:00"); }
  function seconds(value) { return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0; }

  function duration(value, precise = false) {
    const total = seconds(value);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total % 3600 / 60);
    const remainder = total % 60;
    if (precise) return hours ? `${hours}h ${minutes}m ${remainder}s` : minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
    if (hours) return `${hours}h ${minutes}m`;
    return minutes ? `${minutes}m` : total ? `${total}s` : "0m";
  }

  function compactDuration(value) {
    const total = seconds(value);
    if (!total) return "";
    if (total < 60) return "<1m";
    if (total < 3600) return `${Math.floor(total / 60)}m`;
    return `${Number((total / 3600).toFixed(1))}h`;
  }

  function setText(id, value) {
    const element = byId(id);
    const text = String(value);
    if (element.textContent !== text) element.textContent = text;
  }

  /** @template {keyof HTMLElementTagNameMap} T
   * @param {T} tag
   * @param {string} [className]
   * @param {string | number} [text]
   * @returns {HTMLElementTagNameMap[T]} */
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }

  function persist() { vscode.setState({ ...state }); }
  /** @param {import('../src/types').DashboardRequest['type']} type */
  function send(type, extra = {}) { vscode.postMessage(/** @type {import('../src/types').DashboardRequest} */ ({ type, ...extra })); }
  function threshold() { return Math.max(1, seconds(snapshot.summary.qualifyingSeconds) || 900); }
  function record(date) { return snapshot.days[date] || { time: 0, characters: 0, files: [] }; }
  function level(time) { return time <= 0 ? 0 : time < threshold() ? 1 : time < threshold() * 2 ? 2 : time < threshold() * 4 ? 3 : 4; }

  function renderSummary() {
    const summary = snapshot.summary;
    setText("today-value", duration(summary.todaySeconds));
    setText("week-value", duration(summary.weekSeconds));
    setText("week-caption", snapshot.weekStartsOn === 1 ? "Monday through today" : "Sunday through today");
    const streak = seconds(summary.currentStreak);
    const longest = seconds(summary.longestStreak);
    setText("streak-value", `${streak} ${streak === 1 ? "day" : "days"}`);
    setText("longest-value", `Longest: ${longest} ${longest === 1 ? "day" : "days"}`);
    const goal = seconds(summary.goalSeconds);
    const progress = goal ? Math.min(100, Math.floor(seconds(summary.todaySeconds) / goal * 100)) : 0;
    setText("goal-value", goal ? `${progress}%` : "Off");
    setText("goal-caption", goal ? `${duration(summary.todaySeconds)} of ${duration(goal)}${progress === 100 ? " · Complete" : " today"}` : "Enable a goal in Settings");
    byId("goal-progress").value = progress;
    byId("goal-progress").hidden = !goal;
    byId("goal-progress").setAttribute("aria-valuetext", goal ? `${progress}% of ${duration(goal)}` : "Daily goal disabled");
    const status = ["tracking", "idle", "paused"].includes(snapshot.status) ? snapshot.status : "idle";
    byId("tracking-status").className = `tracking-status ${status}`;
    setText("status-text", status === "tracking" ? "Tracking active time" : status === "paused" ? "Tracking paused" : "Idle");
    byId("tracking-status").title = status === "tracking" ? "Activity keeps your coding session active." : status === "paused" ? "Resume when you are ready to track again." : "Tracking resumes when you return to an eligible editor.";
    setText("pause-button", snapshot.paused ? "Resume" : "Pause");
    byId("pause-button").disabled = Boolean(snapshot.recoveryRequired);
    byId("storage-banner").hidden = !snapshot.recoveryRequired;
    setText("storage-error", snapshot.storageError || "History needs recovery before tracking can resume.");
    byId("pause-button").setAttribute("aria-label", snapshot.paused ? "Resume activity tracking" : "Pause activity tracking");
    setText("streak-threshold", `${duration(threshold())} of active time makes a streak day.`);
    const labels = ["No active time", `Under ${duration(threshold())}`, `${duration(threshold())} to under ${duration(threshold() * 2)}`, `${duration(threshold() * 2)} to under ${duration(threshold() * 4)}`, `${duration(threshold() * 4)} or more`];
    labels.forEach((label, index) => { byId(`legend-${index}`).title = label; byId(`legend-${index}`).setAttribute("aria-label", label); });
  }

  function renderProjects() {
    const projects = Array.isArray(snapshot.projects) ? snapshot.projects : [];
    const signature = JSON.stringify(projects);
    const filter = byId("project-filter");
    if (signature !== projectsKey) {
      projectsKey = signature;
      const options = [element("option", "", "All projects")];
      options[0].value = "";
      for (const project of projects) {
        const option = element("option", "", project.name || "Unnamed project");
        option.value = project.id;
        options.push(option);
      }
      filter.replaceChildren(...options);
    }
    filter.value = state.projectId;
    const project = projects.find((item) => item.id === state.projectId);
    setText("calendar-description", project ? `Activity in ${project.name}.` : "Your activity across all projects.");
  }

  function makeMonth(year, month, compact) {
    const section = element("section", compact ? "mini-month" : "full-month");
    const start = new Date(year, month, 1, 12);
    const monthKey = dateKey(start).slice(0, 7);
    section.setAttribute("aria-label", monthFormatter.format(start));
    if (compact) {
      const heading = element("div", "mini-month-heading");
      const button = element("button", "", start.toLocaleDateString(undefined, { month: "long" }));
      button.type = "button";
      button.dataset.month = monthKey + "-01";
      button.disabled = monthKey > snapshot.today.slice(0, 7);
      button.setAttribute("aria-label", `Show ${monthFormatter.format(start)}`);
      const total = element("span", "mini-month-total");
      monthTotals.set(monthKey, total);
      heading.append(button, total);
      section.append(heading);
    }
    const weekdays = element("div", "weekdays");
    weekdays.setAttribute("aria-hidden", "true");
    const weekStart = snapshot.weekStartsOn === 1 ? 1 : 0;
    for (let i = 0; i < 7; i++) {
      const weekday = new Date(2023, 0, 1 + (i + weekStart) % 7, 12);
      const label = element("span", "weekday", weekday.toLocaleDateString(undefined, { weekday: compact ? "narrow" : "short" }));
      weekdays.append(label);
    }
    const grid = element("div", "days-grid");
    const offset = (start.getDay() - weekStart + 7) % 7;
    for (let i = 0; i < offset; i++) {
      const blank = element("span", "day-placeholder");
      blank.setAttribute("aria-hidden", "true");
      grid.append(blank);
    }
    const count = new Date(year, month + 1, 0).getDate();
    for (let day = 1; day <= count; day++) {
      const key = dateKey(new Date(year, month, day, 12));
      const button = element("button", "day-cell");
      button.type = "button";
      button.dataset.date = key;
      button.tabIndex = -1;
      button.append(element("span", "day-number", day));
      if (!compact) button.append(element("span", "day-time"));
      dateButtons.set(key, button);
      grid.append(button);
    }
    section.append(weekdays, grid);
    return section;
  }

  function renderCalendar() {
    const viewed = parseDate(state.viewedMonth);
    const year = viewed.getFullYear();
    const month = viewed.getMonth();
    const key = `${state.mode}:${state.viewedMonth}:${snapshot.weekStartsOn}`;
    if (calendarKey !== key) {
      calendarKey = key;
      dateButtons.clear();
      monthTotals.clear();
      const calendar = byId("calendar");
      calendar.className = state.mode === "year" ? "calendar-content year-grid" : "calendar-content";
      const sections = state.mode === "year" ? Array.from({ length: 12 }, (_, i) => makeMonth(year, i, true)) : [makeMonth(year, month, false)];
      calendar.replaceChildren(...sections);
    }
    const title = state.mode === "year" ? String(year) : monthFormatter.format(viewed);
    setText("period-title", title);
    byId("month-view").setAttribute("aria-pressed", String(state.mode === "month"));
    byId("year-view").setAttribute("aria-pressed", String(state.mode === "year"));
    byId("previous-period").setAttribute("aria-label", `Previous ${state.mode}`);
    byId("next-period").setAttribute("aria-label", `Next ${state.mode}`);
    byId("next-period").disabled = state.mode === "year" ? year >= parseDate(snapshot.today).getFullYear() : state.viewedMonth.slice(0, 7) >= snapshot.today.slice(0, 7);
    const available = [...dateButtons].filter(([date]) => date <= snapshot.today);
    const tabDate = dateButtons.has(state.selectedDate) ? state.selectedDate : dateButtons.has(snapshot.today) ? snapshot.today : available[0]?.[0];
    for (const [date, button] of dateButtons) {
      const time = seconds(record(date).time);
      const selected = date === state.selectedDate;
      button.dataset.level = String(level(time));
      button.classList.toggle("is-selected", selected);
      button.classList.toggle("is-today", date === snapshot.today);
      button.classList.toggle("is-future", date > snapshot.today);
      button.disabled = date > snapshot.today;
      button.tabIndex = date === tabDate && !button.disabled ? 0 : -1;
      button.setAttribute("aria-pressed", String(selected));
      if (date === snapshot.today) button.setAttribute("aria-current", "date");
      else button.removeAttribute("aria-current");
      const label = `${fullDateFormatter.format(parseDate(date))}: ${date > snapshot.today ? "Future date" : time ? `${duration(time, true)} active time` : "No active time"}${date === snapshot.today ? ", today" : ""}`;
      button.setAttribute("aria-label", label);
      button.title = label;
      const timeLabel = button.querySelector(".day-time");
      if (timeLabel && timeLabel.textContent !== compactDuration(time)) timeLabel.textContent = compactDuration(time);
    }
    for (const [monthKey, label] of monthTotals) {
      label.parentElement.querySelector("button").disabled = monthKey > snapshot.today.slice(0, 7);
      const total = Object.entries(snapshot.days).reduce((sum, [date, day]) => sum + (date.startsWith(monthKey + "-") ? seconds(day.time) : 0), 0);
      const text = total ? duration(total) : "";
      if (label.textContent !== text) label.textContent = text;
    }
  }

  function renderFiles(files) {
    const signature = JSON.stringify([state.selectedDate, files]);
    if (signature === filesKey) return;
    filesKey = signature;
    const list = byId("file-list");
    const groups = new Map();
    for (const file of files) {
      const id = file.projectId || "";
      if (!groups.has(id)) groups.set(id, { name: file.projectName || "Other files", files: [] });
      groups.get(id).files.push(file);
    }
    setText("file-project-count", groups.size ? `${groups.size} ${groups.size === 1 ? "project" : "projects"}` : "");
    if (!files.length) {
      list.replaceChildren(element("p", "empty-files", "No file edits recorded for this day."));
      return;
    }
    const sections = [];
    for (const group of [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const section = element("section", "file-group");
      const heading = element("div", "file-group-heading");
      heading.append(element("h5", "", group.name), element("span", "file-group-count", group.files.length));
      const ul = element("ul", "file-list");
      for (const file of group.files.sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
        const path = String(file.path || "Untitled");
        const name = path.split(/[\\/]/).pop() || path;
        const row = element("li");
        row.title = path;
        const icon = element("span", "file-symbol");
        icon.setAttribute("aria-hidden", "true");
        const labels = element("span", "file-labels");
        labels.append(element("span", "file-name", name));
        if (name !== path) labels.append(element("span", "file-path", path));
        row.append(icon, labels);
        ul.append(row);
      }
      section.append(heading, ul);
      sections.push(section);
    }
    list.replaceChildren(...sections);
  }

  function renderDetails() {
    const day = record(state.selectedDate);
    const time = seconds(day.time);
    const files = Array.isArray(day.files) ? day.files : [];
    setText("selected-day-context", state.selectedDate === snapshot.today ? "TODAY" : "SELECTED DAY");
    setText("selected-day-title", fullDateFormatter.format(parseDate(state.selectedDate)));
    setText("day-duration", duration(time, true));
    setText("day-characters", numberFormatter.format(seconds(day.characters)));
    setText("day-file-count", numberFormatter.format(files.length));
    byId("day-badge").hidden = time < threshold();
    setText("day-badge", "Streak day");
    const hasActivity = time > 0 || seconds(day.characters) > 0 || files.length > 0;
    setText("day-note", hasActivity ? "Characters added includes pasted text. Active time can include reading between edits." : state.selectedDate === snapshot.today ? "Your next session starts here. Open a file and begin working to record activity." : "No activity recorded. Every new day is a fresh start.");
    if (snapshot.selectedDate && snapshot.selectedDate !== state.selectedDate) {
      filesKey = "";
      byId("file-list").replaceChildren(element("p", "empty-files", "Loading file details…"));
    } else renderFiles(files);
  }

  function dateRange(start, end) {
    return `${shortDateFormatter.format(parseDate(start))} – ${shortDateFormatter.format(parseDate(end))}`;
  }

  function renderInsights() {
    const insights = snapshot.insights;
    if (!insights) return;
    const project = snapshot.projects.find((item) => item.id === state.projectId);
    setText("insights-context", `${dateRange(insights.start, insights.end)} · ${project ? project.name : "All projects"}`);
    const change = insights.changePercent;
    const changeText = change === null ? "No baseline" : change === 0 ? "No change" : `${percentFormatter.format(Math.abs(change) / 100)} ${change > 0 ? "more" : "less"}`;
    setText("week-change", changeText);
    const difference = Math.abs(insights.changeSeconds);
    setText("week-comparison", change === null ? "No active time in the comparison period" : difference === 0 ? "Same active time as last week" : `${difference < 1 ? "<1s" : duration(difference)} ${insights.changeSeconds > 0 ? "more" : "less"} active time`);
    setText("week-average", insights.averageSeconds > 0 && insights.averageSeconds < 1 ? "<1s" : duration(insights.averageSeconds));
    setText("week-active-days", `${insights.activeDays} active ${insights.activeDays === 1 ? "day" : "days"} this week`);
    setText("week-goal-days", insights.goalDays === null ? "Off" : `${insights.goalDays} ${insights.goalDays === 1 ? "day" : "days"}`);
    setText("week-goal-context", insights.goalDays === null ? "Enable a daily goal in Settings" : `${duration(snapshot.summary.goalSeconds)} daily target`);
    setText("insights-note", `Compared with ${dateRange(insights.comparisonStart, insights.comparisonEnd)} (the same weekdays). Goal days use your current target.`);
  }

  function renderBreakdown() {
    const period = snapshot.breakdown?.[state.breakdownPeriod];
    if (!period) return;
    const project = snapshot.projects.find((item) => item.id === state.projectId);
    setText("breakdown-context", `${dateRange(period.start, period.end)} · ${project ? project.name : "All projects"}`);
    for (const name of ["week", "month"]) byId(`breakdown-${name}`).setAttribute("aria-pressed", String(name === state.breakdownPeriod));
    const signature = JSON.stringify([state.breakdownPeriod, period.projects, period.totalSeconds]);
    if (signature !== breakdownKey) {
      breakdownKey = signature;
      const rows = period.projects.map((project) => {
        const row = element("li", "project-time-row");
        const heading = element("div", "project-time-heading");
        const name = element("span", "project-time-name", project.name);
        name.title = project.id;
        const time = project.seconds > 0 && project.seconds < 1 ? "<1s" : duration(project.seconds);
        const share = percentFormatter.format(period.totalSeconds > 0 ? project.seconds / period.totalSeconds : 0);
        heading.append(name, element("span", "project-time-value", `${time} · ${share}`));
        const bar = element("meter", "project-time-bar");
        bar.min = 0;
        bar.max = period.totalSeconds || 1;
        bar.value = project.seconds;
        bar.setAttribute("aria-label", `${project.name} active time`);
        bar.setAttribute("aria-valuetext", `${time}, ${share} of active time`);
        row.append(heading, bar);
        return row;
      });
      byId("project-breakdown").replaceChildren(...rows);
    }
    byId("breakdown-empty").hidden = period.projects.length > 0;
    const total = period.totalSeconds > 0 && period.totalSeconds < 1 ? "<1s" : duration(period.totalSeconds);
    setText("breakdown-total", `${total} total · ${period.projects.length} ${period.projects.length === 1 ? "project" : "projects"} with active time`);
  }

  function languageName(id) {
    const names = {
      unknown: "Unknown language", plaintext: "Plain Text", javascript: "JavaScript",
      javascriptreact: "JavaScript React", typescript: "TypeScript", typescriptreact: "TypeScript React",
      python: "Python", markdown: "Markdown", json: "JSON", jsonc: "JSON with Comments",
      html: "HTML", css: "CSS", scss: "SCSS", less: "Less", vue: "Vue", svelte: "Svelte",
      shellscript: "Shell Script", go: "Go", rust: "Rust", java: "Java", c: "C", cpp: "C++",
      csharp: "C#", php: "PHP", ruby: "Ruby", swift: "Swift", kotlin: "Kotlin",
      sql: "SQL", yaml: "YAML", xml: "XML", dockerfile: "Dockerfile",
    };
    return Object.hasOwn(names, id) ? names[id] : id;
  }

  function renderLanguages() {
    const period = snapshot.breakdown?.[state.languagePeriod];
    if (!period) return;
    const languages = period.languages || [];
    const project = snapshot.projects.find((item) => item.id === state.projectId);
    setText("language-context", `${dateRange(period.start, period.end)} · ${project ? project.name : "All projects"}`);
    for (const name of ["week", "month"]) byId(`language-${name}`).setAttribute("aria-pressed", String(name === state.languagePeriod));
    const signature = JSON.stringify([state.languagePeriod, languages, period.totalSeconds]);
    if (signature !== languageKey) {
      languageKey = signature;
      const rows = languages.map((language) => {
        const row = element("li", "language-time-row");
        const heading = element("div", "project-time-heading");
        const name = element("span", "project-time-name", languageName(language.id));
        name.title = language.id;
        const time = language.seconds > 0 && language.seconds < 1 ? "<1s" : duration(language.seconds);
        const share = percentFormatter.format(period.totalSeconds > 0 ? language.seconds / period.totalSeconds : 0);
        heading.append(name, element("span", "project-time-value", `${time} · ${share}`));
        const bar = element("meter", "project-time-bar");
        bar.min = 0;
        bar.max = period.totalSeconds || 1;
        bar.value = language.seconds;
        bar.setAttribute("aria-label", `${languageName(language.id)} active time`);
        bar.setAttribute("aria-valuetext", `${time}, ${share} of active time`);
        row.append(heading, bar);
        return row;
      });
      byId("language-breakdown").replaceChildren(...rows);
    }
    byId("language-empty").hidden = languages.length > 0;
    byId("language-note").hidden = !languages.some((language) => language.id === "unknown");
    const total = period.totalSeconds > 0 && period.totalSeconds < 1 ? "<1s" : duration(period.totalSeconds);
    setText("language-total", `${total} total · ${languages.length} ${languages.length === 1 ? "language" : "languages"} with active time`);
  }

  function renderReport() {
    for (const name of ["start", "end"]) {
      const input = /** @type {HTMLInputElement} */ (byId(`report-${name}`));
      input.max = snapshot.today;
      if (!input.value) input.value = state[name === "start" ? "reportStart" : "reportEnd"] || (name === "start" ? snapshot.today.slice(0, 7) + "-01" : snapshot.today);
    }
    const report = snapshot.report;
    byId("report-results").hidden = !report;
    if (!report) return;
    const project = snapshot.projects.find((item) => item.id === state.projectId);
    setText("report-context", `${dateRange(report.start, report.end)} · ${project ? project.name : "All projects"}`);
    setText("report-time", duration(report.totalSeconds, true));
    setText("report-days", report.activeDays);
    setText("report-average", duration(report.averageSeconds, true));
    setText("report-goals", report.goalDays === null ? "Off" : report.goalDays);
    const change = report.changePercent;
    const comparison = change === null ? "No baseline" : change === 0 ? "No change" : `${percentFormatter.format(Math.abs(change) / 100)} ${change > 0 ? "more" : "less"}`;
    setText("report-comparison", `${comparison} active time compared with ${dateRange(report.comparisonStart, report.comparisonEnd)}. Goal days use your current target.`);
    byId("report-empty").hidden = report.totalSeconds > 0;
    const signature = JSON.stringify([report.projects, report.languages, report.totalSeconds]);
    if (signature === reportKey) return;
    reportKey = signature;
    for (const kind of ["projects", "languages"]) {
      const rows = report[kind].map((item) => {
        const name = kind === "projects" ? item.name : languageName(item.id);
        const row = element("li", "project-time-row");
        const heading = element("div", "project-time-heading");
        const share = percentFormatter.format(report.totalSeconds ? item.seconds / report.totalSeconds : 0);
        heading.append(element("span", "project-time-name", name), element("span", "project-time-value", `${duration(item.seconds)} · ${share}`));
        const meter = element("meter", "project-time-bar");
        meter.min = 0; meter.max = report.totalSeconds || 1; meter.value = item.seconds;
        meter.setAttribute("aria-label", `${name} active time`);
        meter.setAttribute("aria-valuetext", `${duration(item.seconds)}, ${share} of active time`);
        row.append(heading, meter);
        return row;
      });
      byId(`report-${kind}`).replaceChildren(...rows);
    }
  }

  function render() {
    if (!snapshot) return;
    renderSummary();
    renderProjects();
    renderCalendar();
    renderDetails();
    renderInsights();
    renderBreakdown();
    renderLanguages();
    renderReport();
    byId("dashboard").setAttribute("aria-busy", "false");
  }

  function changePeriod(direction) {
    if (!snapshot) return;
    const date = parseDate(state.viewedMonth);
    date.setMonth(date.getMonth() + direction * (state.mode === "year" ? 12 : 1));
    const next = dateKey(date);
    if (direction > 0 && (state.mode === "year" ? date.getFullYear() > parseDate(snapshot.today).getFullYear() : next.slice(0, 7) > snapshot.today.slice(0, 7))) return;
    state.viewedMonth = next;
    persist();
    renderCalendar();
    setText("calendar-announcement", byId("period-title").textContent);
  }

  function selectDate(date, focus = false) {
    if (!snapshot || !isDateKey(date) || date > snapshot.today) return;
    state.selectedDate = date;
    requestedDate = date;
    send("selectDate", { date });
    if (state.mode === "month" && date.slice(0, 7) !== state.viewedMonth.slice(0, 7) || state.mode === "year" && date.slice(0, 4) !== state.viewedMonth.slice(0, 4)) state.viewedMonth = date.slice(0, 7) + "-01";
    persist();
    renderCalendar();
    renderDetails();
    if (focus) dateButtons.get(date)?.focus({ preventScroll: true });
    setText("calendar-announcement", `Selected ${fullDateFormatter.format(parseDate(date))}, ${duration(record(date).time, true)} active time.`);
  }

  byId("previous-period").addEventListener("click", () => changePeriod(-1));
  byId("next-period").addEventListener("click", () => changePeriod(1));
  byId("today-button").addEventListener("click", () => {
    if (!snapshot) return;
    state.viewedMonth = snapshot.today.slice(0, 7) + "-01";
    selectDate(snapshot.today);
  });
  for (const mode of ["month", "year"]) byId(`${mode}-view`).addEventListener("click", () => {
    if (!snapshot) return;
    state.mode = mode;
    persist();
    renderCalendar();
    setText("calendar-announcement", `${mode === "year" ? "Year" : "Month"} view, ${byId("period-title").textContent}`);
  });
  byId("calendar").addEventListener("click", (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest("button");
    if (!button || button.disabled) return;
    if (button.dataset.date) selectDate(button.dataset.date);
    else if (button.dataset.month) {
      state.viewedMonth = button.dataset.month;
      state.mode = "month";
      persist();
      renderCalendar();
      byId("period-title").setAttribute("tabindex", "-1");
      byId("period-title").focus({ preventScroll: true });
    }
  });
  byId("calendar").addEventListener("keydown", (event) => {
    const button = /** @type {HTMLElement} */ (event.target).closest("button");
    if (!button || !snapshot) return;
    const date = parseDate(button.dataset.date);
    const steps = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (Object.hasOwn(steps, event.key)) date.setDate(date.getDate() + steps[event.key]);
    else if (event.key === "Home") date.setDate(date.getDate() - (date.getDay() - (snapshot.weekStartsOn === 1 ? 1 : 0) + 7) % 7);
    else if (event.key === "End") date.setDate(date.getDate() + 6 - (date.getDay() - (snapshot.weekStartsOn === 1 ? 1 : 0) + 7) % 7);
    else if (event.key === "PageUp" || event.key === "PageDown") {
      const day = date.getDate();
      date.setDate(1);
      date.setMonth(date.getMonth() + (event.key === "PageUp" ? -1 : 1));
      date.setDate(Math.min(day, new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()));
    } else return;
    event.preventDefault();
    const key = dateKey(date);
    selectDate(key > snapshot.today ? snapshot.today : key, true);
  });
  byId("project-filter").addEventListener("change", (event) => {
    state.projectId = /** @type {HTMLSelectElement} */ (event.target).value;
    persist();
    send("filter", { projectId: state.projectId });
  });
  for (const period of ["week", "month"]) byId(`breakdown-${period}`).addEventListener("click", () => {
    state.breakdownPeriod = period;
    persist();
    if (snapshot) renderBreakdown();
  });
  for (const period of ["week", "month"]) byId(`language-${period}`).addEventListener("click", () => {
    state.languagePeriod = period;
    persist();
    if (snapshot) renderLanguages();
  });
  byId("report-form").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!snapshot) return;
    const start = byId("report-start").value;
    const end = byId("report-end").value;
    if (!isDateKey(start) || !isDateKey(end) || start > end || end > snapshot.today) {
      setText("report-error", "Choose valid dates in order, ending on or before today.");
      byId("report-error").hidden = false;
      return;
    }
    byId("report-error").hidden = true;
    state.reportStart = start;
    state.reportEnd = end;
    persist();
    send("report", { start, end });
  });
  byId("recover-button").addEventListener("click", () => send("recoverHistory"));
  byId("pause-button").addEventListener("click", () => send("togglePause"));
  byId("settings-button").addEventListener("click", () => send("settings"));
  for (const button of document.querySelectorAll("button[data-action]")) button.addEventListener("click", () => {
    byId("data-menu").open = false;
    byId("data-menu").querySelector("summary").focus();
    send(/** @type {import("../src/types").DashboardRequest["type"]} */ (button.getAttribute("data-action")));
  });
  document.addEventListener("click", (event) => { if (!byId("data-menu").contains(/** @type {Node} */ (event.target))) byId("data-menu").open = false; });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && byId("data-menu").open) {
      byId("data-menu").open = false;
      byId("data-menu").querySelector("summary").focus();
    }
  });
  window.addEventListener("message", (event) => {
    let data = event.data;
    if (data?.type === "patch") {
      if (!snapshot || data.baseRevision !== revision) { send("ready"); return; }
      const days = { ...snapshot.days, ...data.days };
      for (const date of data.removedDays || []) delete days[date];
      data = { ...data, type: "snapshot", days };
    }
    if (!data || data.type !== "snapshot" || !isDateKey(data.today) || !data.days || !data.summary) return;
    const previousToday = snapshot?.today;
    snapshot = data;
    revision = data.revision || 0;
    if (!state.selectedDate || state.selectedDate > data.today) state.selectedDate = data.today;
    if (!state.viewedMonth || state.viewedMonth.slice(0, 7) > data.today.slice(0, 7)) state.viewedMonth = data.today.slice(0, 7) + "-01";
    if (previousToday && previousToday !== data.today && state.selectedDate === previousToday) {
      const wasViewingToday = state.viewedMonth.slice(0, 7) === previousToday.slice(0, 7);
      state.selectedDate = data.today;
      if (wasViewingToday) state.viewedMonth = data.today.slice(0, 7) + "-01";
    }
    state.projectId = typeof data.projectId === "string" ? data.projectId : "";
    persist();
    render();
    if (data.selectedDate && data.selectedDate !== state.selectedDate && requestedDate !== state.selectedDate) {
      requestedDate = state.selectedDate;
      send("selectDate", { date: state.selectedDate });
    }
    if (!restoredReport) {
      restoredReport = true;
      if (state.reportStart && state.reportEnd && state.reportStart <= state.reportEnd && state.reportEnd <= data.today) {
        send("report", { start: state.reportStart, end: state.reportEnd });
      }
    }
  });

  const restoredProjectId = state.projectId;
  send("ready");
  if (restoredProjectId) send("filter", { projectId: restoredProjectId });
})();
