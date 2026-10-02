# DevStreak

DevStreak is a local-only VS Code extension for understanding your coding habits. It tracks active editor time, characters added, and files edited, with a live calendar, streaks, and an optional daily goal.

## Getting started

Click the stopwatch in the status bar or run **DevStreak: Open Activity** from the Command Palette. On first opening, the dashboard shows the current month with today selected. While the tab remains open, switching away and back restores your selected date, calendar view, and project filter.

- See today's active time, this week's total, your current and longest streak, and daily goal progress.
- Review weekly insights: active time compared with the same weekdays last week, average time per active day, and days meeting your current daily goal.
- See each project's duration and share of active time for this week or this month, through today. The breakdown period is remembered while the dashboard tab remains open.
- Navigate between months or switch to a compact year overview.
- Select a date for its precise duration, character count, and edited files grouped by project.
- Filter the dashboard by project. The status bar always shows the total across all projects.
- Pause or resume tracking from the dashboard or the Command Palette.
- Open **Settings** to adjust the idle timeout, goals, streak threshold, week start, and ignored folders.
- Use **More** to back up history as JSON, export CSV, import a backup, or clear history. Import and clear require confirmation.

## What is counted

Tracking starts after interaction with an eligible editor: editing text, changing the selection with the keyboard or mouse, scrolling, or switching files. Opening VS Code alone does not count as activity.

Active time continues between interactions up to the configured idle timeout, allowing time for reading and thinking. Counting stops when any of these conditions applies:

- VS Code reports the window inactive, even if it is still focused.
- The window loses focus.
- There has been no eligible editor interaction for the configured timeout.
- The active editor is excluded or tracking is paused.

The default timeout is **5 minutes**, configurable with `devstreak.idleTimeoutMinutes`. VS Code's inactivity signal can stop counting sooner; the setting is a maximum grace period. While idle, the status bar and dashboard show **Idle**, and the timer stays frozen. Tracking resumes on eligible editor interaction without adding the elapsed idle period.

A gap of more than 15 seconds between timer ticks, such as computer sleep or a stalled extension host, is discarded. Opening VS Code, waking the computer, or restoring window focus alone does not start a session. Manual pause is saved for the current workspace and remains in effect when you reopen it.

**Characters added** includes inserted text from typing, pasting, formatting, undo/redo, and other document changes in an eligible active editor while tracking is allowed. Changes while paused, inactive, or unfocused are excluded. Unicode code points are counted; this is an activity measure, not a count of keyboard presses or a productivity score. Deletions record a file edit without adding characters.

Files are identified by their full URI and displayed with workspace-relative paths, so two files named `index.js` remain distinct. Local files, untitled documents, and remote editor files are eligible; output and preview documents are excluded. Files outside a workspace are grouped as **Other files**. This release tracks editor activity; terminal commands and debugger actions do not independently start or extend an editor session.

Dates follow the extension host's local timezone. Sessions crossing midnight are split between the correct calendar days, including daylight saving transitions. With remote development, the extension host and its storage may be on the remote machine.

A streak day must meet the configured minimum active time: **15 minutes** by default. The current streak remains visible through today while you work toward that minimum; a missed previous day breaks it. The activity colors represent active time rather than character counts. For a streak threshold of `T` minutes, the levels are no active time, under `T`, `T` to under `2T`, `2T` to under `4T`, and `4T` or more. Exact thresholds appear in the legend tooltips. Empty records do not count as active days.

Project filters apply to calendar details, streaks, weekly totals, goal progress, weekly insights, and project breakdowns. The status bar and data exports always include all projects.

Weekly comparisons respect your configured week start and compare the same elapsed weekdays in each week. An empty previous period shows **No baseline**. Average time uses only days with positive active time; edits without active time do not count as active days or appear in the time breakdown. Goal days are calculated using your current target, so changing it updates historical goal counts; disabling the goal shows **Off**. Insight and breakdown date ranges follow the current local day independently of calendar navigation.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `devstreak.idleTimeoutMinutes` | `5` | Maximum grace period after editor interaction; 1–60 minutes. Inactivity or loss of focus stops counting sooner. |
| `devstreak.dailyGoalMinutes` | `60` | Daily target; set to `0` to disable it. |
| `devstreak.streakMinimumMinutes` | `15` | Active time needed for a qualifying streak day. |
| `devstreak.weekStartsOn` | `monday` | Calendar and weekly summaries can start Monday or Sunday. |
| `devstreak.ignoredFolders` | `["node_modules", ".git", "dist", "build"]` | Excluded folder names or relative folder paths, such as `src/generated`. |

Folder exclusions match complete path segments. Wildcards are not supported. Settings can be configured per workspace using VS Code's usual settings UI.

## Privacy, storage, and backups

DevStreak does not transmit activity or use external services. History is stored in `activity.json` within the extension's VS Code global storage directory. Writes use atomic replacement and a filesystem lock to merge activity safely across windows sharing that directory. Focus handling prevents unfocused windows from accumulating time. Different VS Code profiles or remote hosts can have separate storage.

Existing history migrates once into **Earlier activity**. Original date buckets and measurements are preserved because older records used UTC dates and elapsed wall time; their project identity and original timezone cannot be reconstructed. Migration leaves the original VS Code record intact. Explicit clear/import operations also remove that original record in the current extension host.

JSON export is a restorable backup of all projects, including file URIs and paths. Backups use data format version `2`; this is separate from the extension release version. CSV export contains one row per date and project with active seconds, character totals, file counts, and paths. Neither export is limited by the dashboard's project filter. Import accepts DevStreak version-2 JSON backups up to **20 MB**, validates their structure, and replaces existing history; export a backup first if you want to retain it. Other windows discard pending activity from the replaced history on their next save.

Activity saves every five seconds and on normal extension deactivation. A forced crash can lose activity since the last completed save. Corrupt or unsupported stored data produces an error instead of being overwritten.

The dashboard uses VS Code theme colors, adapts to narrow editor groups, and provides keyboard navigation, visible focus, and reduced-motion support.

## Commands and keyboard navigation

All commands are available from the Command Palette:

| Command | Action |
| --- | --- |
| **DevStreak: Open Activity** | Open or reveal the dashboard. |
| **DevStreak: Pause / Resume Tracking** | Toggle manual tracking pause for this workspace. |
| **DevStreak: Open Settings** | Open DevStreak settings. |
| **DevStreak: Export JSON Backup** | Save a restorable backup of all history. |
| **DevStreak: Export CSV** | Save a date/project activity report. |
| **DevStreak: Import JSON Backup** | Replace history with a validated backup after confirmation. |
| **DevStreak: Clear History** | Delete history after confirmation. |

Tab to a date in the calendar, then use:

- **Left/Right arrows:** previous/next day.
- **Up/Down arrows:** previous/next week.
- **Home/End:** start/end of the week.
- **Page Up/Page Down:** previous/next month, retaining the day where possible.

Future dates are disabled. The **Today** button returns to the current date.

## Development

Requires VS Code 1.109 or later and Node.js 22 or later for development tests.

```sh
npm ci
npm test
```

`npm test` runs strict lint checks and the Node regression suite, including idle/focus tracking, timezone/DST boundaries, concurrent storage, migration, backup validation, controller lifecycle, dashboard messages, and keyboard date navigation. The dashboard unit tests use a small simulated DOM; they do not verify browser layout or theme contrast. `npm run test:integration` runs the extension in a separate VS Code test host; it requires a graphical environment and may download VS Code. Set `DEVSTREAK_VSCODE_EXECUTABLE` to an installed VS Code executable to use it instead.

Press **F5** in VS Code to launch the Extension Development Host, then run **DevStreak: Open Activity**. No build step or runtime dependencies are required.

Before a release, run the extension-host tests and inspect the dashboard in light, dark, and high-contrast themes and in a narrow editor group. Check that the timer freezes when idle or unfocused, resumes without backfilling idle time, and that JSON export/import round-trips correctly. Automated simulated-DOM tests do not replace this visual check.

The code is split into `src/tracker.js` for activity timing, `src/model.js` for data and summaries, `src/storage.js` for persistence, `src/controller.js` for VS Code integration, and `media/` for the dashboard.

## License

MIT.
