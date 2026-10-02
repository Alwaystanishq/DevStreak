# Change Log

## Unreleased

- Add weekly insights with comparisons against matching weekdays last week, average time per active day, and daily goal counts, plus project time breakdowns for this week and month that follow the project filter.
- Rebuild the dashboard with today/week/streak/goal summaries, weekday-aligned month and year calendars, activity intensity, project filters, and detailed file groups.
- Add keyboard calendar navigation, responsive layouts, theme support, and persistent selection and view state.
- Track active editor time with idle detection, VS Code inactive-window signals, focus handling, pause/resume, sleep-gap protection, and local-midnight/DST boundaries. Show Idle in the status bar while the timer is stopped.
- Preserve file URI identity and rename the text metric to characters added.
- Add configurable goals, streak qualification, week starts, and excluded folders.
- Add JSON backup/import, CSV export, and confirmed history clearing.
- Migrate existing records into Earlier activity and protect storage with atomic writes, cross-window locks, generation checks, and schema validation.
- Update the dashboard live through messages and render filenames as text under a restrictive Content Security Policy.
- Replace the sample test with regression tests and extension-host smoke tests.
- Preserve successful startup/recovery reads when only storage lock cleanup fails, and make test glob arguments portable across shells.

## 0.0.1

- Initial release with a status-bar stopwatch, daily edit records, and calendar details.
