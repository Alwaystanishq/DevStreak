# DevStreak

**Understand your coding habits, one session at a time.**

DevStreak is a VS Code extension that tracks active editor time, characters added, and files edited. See your progress in a live activity calendar, build a streak, and work toward a daily goal. Activity stays in VS Code's extension storage, with no account or external service required.

Requires **VS Code 1.109 or later**.

## Quick start

1. Open a file and start working: type, move the cursor, scroll, or switch files to begin a session.
2. Click the stopwatch in the status bar, or run **DevStreak: Open Activity** from the Command Palette.
3. Use **Settings** to choose your daily goal, idle timeout, and streak threshold.

The dashboard opens on the current month with today selected. Before your first recorded activity, it explains how tracking works and offers **Set daily goal**, which opens that setting directly. Use **Pause** and **Resume** whenever you want to control tracking manually.

## Explore your activity

| Feature | What you can see |
| --- | --- |
| Daily summary | Today's active time, this week's total, current and longest streaks, and daily goal progress. |
| Activity calendar | Month and year views, intensity levels based on active time, and details for each date. |
| Day details | Precise duration, characters added, and edited files grouped by project. |
| Weekly insights | Comparison with the same weekdays last week, average time per active day, and days meeting your goal. |
| Activity trends | A daily bar chart for the last 7, 30, or 90 days, total time, average per calendar day, active days, and comparison with the preceding period. Includes an accessible daily-values table. |
| Project breakdown | Each project's active time and share for this week or month. |
| Language breakdown | Time and share by the editor's language mode, with its own week/month selection. |
| Date-range report | Totals, active days, goal days, and project/language shares for any past or current date range, compared with the preceding period of the same length. |

The **Project** filter applies to dashboard summaries, calendar details, streaks, goals, trends, and reports. The status bar, notifications, and data exports always include all projects. Weekly and monthly breakdowns and trends run through today, independently of the month you are viewing in the calendar.

Your selected date, calendar view, project filter, breakdown periods, trend period, and applied report dates are remembered while the dashboard tab remains open. The dashboard follows VS Code's theme and adapts to narrow editor groups.

## How tracking works

### Active time

A session begins after an interaction with an eligible editor. Reading and thinking between interactions count toward active time until tracking becomes idle.

The default idle timeout is **5 minutes**. Tracking stops sooner if VS Code reports the window inactive or it loses focus. It also stops when you pause tracking or switch to an excluded editor. Returning to the window alone does not start a session; interact with the editor to resume. Idle time is never added back.

Local files, remote files, and untitled documents are eligible. The default excluded folders are `node_modules`, `.git`, `dist`, and `build`. Files outside a workspace appear under **Other files**. Terminal commands and debugger actions do not independently start or extend a session.

Manual pause is remembered for the current workspace. Gaps longer than 15 seconds between timer ticks, such as computer sleep, are discarded.

### Characters, files, and languages

**Characters added** measures inserted Unicode code points, including typing, pasted text, formatting, undo/redo, and other changes in an eligible active editor. It is an activity measure, rather than a keystroke count. Deletions record a file edit without adding characters. Changes while paused, inactive, or unfocused are excluded.

Edited files retain their full URI identity and display workspace-relative paths, so files with the same name remain distinct. Language time follows the active editor's language mode, including custom languages. Older records without language information appear as **Unknown language**.

### Goals, streaks, and dates

A streak day requires **15 minutes** of active time by default. If yesterday qualified, your current streak stays visible while you work toward today's threshold. A missed previous day breaks the streak. Calendar colors represent active time; hover over the legend to see the thresholds.

The daily goal defaults to **60 minutes** and can be disabled by setting it to `0`. Historical goal-day counts use your current goal. Weekly and date-range averages include only days with positive active time; the trend chart's average includes every calendar day in the selected period. Edits alone do not make an active day. Comparisons show **No baseline** when the preceding period has no active time.

### Optional notifications

Enable **Notify On Daily Goal** or **Notify On Streak** in Settings to receive a notification when newly saved activity reaches the corresponding threshold. Both are off by default. Notifications count all projects and offer **Open Activity**. If both thresholds are reached in the same save, they share one notification.

Each milestone is notified at most once per local day across windows sharing the extension's storage, including after restarting VS Code or clearing history. Loading or importing existing history and changing targets do not trigger notifications. Notification dates and milestone names are stored locally in `notifications.json`, separately from activity backups. Notifications wait for a successful save; they can appear up to five seconds after reaching a threshold.

Dates use the extension host's local timezone, and sessions crossing midnight are split between days. Date-range reports include both endpoints and compare the preceding range with the same number of calendar days. In remote development, the extension host's timezone and storage may be on the remote machine.

## Settings

Open **Settings** from the dashboard or run **DevStreak: Open Settings**. You can also configure these values in VS Code's user or workspace settings.

| Setting | Default | Description |
| --- | --- | --- |
| `devstreak.idleTimeoutMinutes` | `5` | Maximum time between editor interactions before becoming idle; accepts 1–60 minutes. Inactivity or loss of focus can stop tracking sooner. |
| `devstreak.dailyGoalMinutes` | `60` | Daily active-time target; accepts 0–1440 minutes. Set to `0` to disable it. |
| `devstreak.streakMinimumMinutes` | `15` | Active time needed for a streak day; accepts 1–1440 minutes. |
| `devstreak.notifyOnDailyGoal` | `false` | Notify once per local day when newly saved activity reaches the daily goal. A goal of `0` disables this notification. |
| `devstreak.notifyOnStreak` | `false` | Notify once per local day when newly saved activity reaches the streak threshold. |
| `devstreak.weekStartsOn` | `"monday"` | Start calendar weeks and weekly summaries on `"monday"` or `"sunday"`. |
| `devstreak.ignoredFolders` | `["node_modules", ".git", "dist", "build"]` | Folder names or relative folder paths to exclude, such as `src/generated`. |

Folder exclusions match complete path segments. Wildcards are not supported.

## Privacy and saving

DevStreak does not transmit activity or use external services. History is stored in `activity.json` in VS Code's global storage directory for the extension. It includes dates, project identities, file URIs and paths, character totals, and active time by language. Document contents are not stored.

Activity saves every **five seconds** and on normal extension deactivation. The dashboard footer shows the current state:

| Status | Meaning |
| --- | --- |
| **Saving…** | Changes are waiting to be saved or a storage operation is running. |
| **Saved on this device.** | The latest activity has been saved. With remote development, storage may be on the remote host. |
| **Save failed.** | A storage operation failed. The error appears with a **Retry save** button; automatic saves also retry. |
| **History needs recovery.** | Stored history could not be loaded safely. Use **Recover history** before tracking can resume. |

A forced crash can lose activity since the last completed save. Windows sharing the same storage merge their activity using atomic writes and a filesystem lock. Different VS Code profiles and remote hosts may have separate history.

## Backups, exports, and recovery

Open **More** in the dashboard to manage your history:

- **Back up as JSON:** Save a restorable copy of all projects, including file identifiers, paths, and language time.
- **Export as CSV:** Save one row per date and project with active seconds, characters, file counts, paths, and language time.
- **Import JSON backup:** Validate a backup and replace existing history after confirmation.
- **Clear history…:** Delete history after confirmation.

JSON export and import share a **100 MiB** limit. New backups use data format version `3`; version-2 backups are also accepted and migrated automatically. Earlier language time is preserved as **Unknown language**. Exports always include all projects, regardless of the dashboard filter.

Import and clear affect every window sharing the storage directory. Export a backup first if you want to keep your current history. Other windows discard pending activity from replaced history on their next save.

If history is corrupt or unsupported, tracking pauses and recovery controls remain available. Choose **Recover history** in the dashboard or run **DevStreak: Recover History**, then select:

- **Retry loading** to try reading the stored history again, including after another window repairs it.
- **Restore JSON backup** to replace it with a validated backup.
- **Reset history** to start again with empty history.

Restore and reset require confirmation. They preserve damaged storage as `activity.corrupt-<timestamp>-<id>.json` alongside `activity.json` before replacing it.

Legacy history from earlier DevStreak versions migrates into **Earlier activity**. Its original date buckets and measurements are preserved; project identity and timezone cannot be reconstructed.

## Commands

Open the Command Palette and search for **DevStreak**.

| Command | Action |
| --- | --- |
| **DevStreak: Open Activity** | Open or reveal the dashboard. |
| **DevStreak: Pause / Resume Tracking** | Toggle tracking for the current workspace. |
| **DevStreak: Open Settings** | Open the extension's settings. |
| **DevStreak: Export JSON Backup** | Save a restorable backup of all history. |
| **DevStreak: Export CSV** | Save a date/project activity report. |
| **DevStreak: Import JSON Backup** | Replace history with a validated backup after confirmation. |
| **DevStreak: Clear History** | Delete history after confirmation. |
| **DevStreak: Recover History** | Retry loading, restore a backup, or reset damaged history. |

## Keyboard navigation

Tab to a date in the month calendar, then use these keys:

| Key | Action |
| --- | --- |
| Left / Right | Previous / next day. |
| Up / Down | Previous / next week. |
| Home / End | First / last day of the week. |
| Page Up / Page Down | Previous / next month, keeping the day where possible. |

Future dates are disabled. Use **Today** to return to the current date. Controls provide visible keyboard focus, and the dashboard supports reduced motion.

## Development

Use **Node.js 22 or later** and **VS Code 1.109 or later**.

```sh
npm ci
```

Open the project in VS Code and press **F5** to launch the Extension Development Host. In that window, run **DevStreak: Open Activity**. No build step or runtime dependencies are required.

| Script | Purpose |
| --- | --- |
| `npm run lint` | Check JavaScript with ESLint. |
| `npm run typecheck` | Check JavaScript and shared JSDoc types. |
| `npm test` | Run lint, type checking, and the existing Node unit tests. |
| `npm run test:integration` | Run the existing extension-host tests; requires a graphical environment and may download VS Code. |

For extension-host tests, set `DEVSTREAK_VSCODE_EXECUTABLE` to an installed VS Code executable to use that installation.

The main modules are `src/tracker.js` for timing, `src/model.js` for summaries, `src/storage.js` for persistence, and `src/controller.js` for VS Code integration. Dashboard markup is in `src/webview.js`, with its script and styles in `media/`.

## Feedback

Report bugs or suggest features in the [GitHub issue tracker](https://github.com/Alwaystanishq/devstreak/issues).

## License

MIT.
