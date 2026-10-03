const { ActivityStore, StaleGenerationError } = require("./storage");
const { ActiveTracker } = require("./tracker");
const { emptyData, applyChanges, summarize, summarizeRange, isDateKey, localDateKey, formatDuration, toCsv } = require("./model");
const { checkBackupSize, encodeBackup, decodeBackup } = require("./backup");
const { documentContext } = require("./context");

class ActivityController {
  /** @param {typeof import('vscode')} vscode
   * @param {import('vscode').ExtensionContext} context
   * @param {import('./types').ControllerOptions} [options] */
  constructor(vscode, context, options = {}) {
    this.vscode = vscode;
    this.context = context;
    this.options = options;
    this.now = options.now || Date.now;
    this.data = emptyData();
    /** @type {import('./types').ActivityChange[]} */
    this.pending = [];
    this.projectId = "";
    /** @type {import('vscode').WebviewPanel | null} */
    this.panel = null;
    /** @type {import('vscode').Disposable[]} */
    this.disposables = [];
    this.stopped = false;
    this.maintenance = false;
    this.lastError = "";
    this.recoveryRequired = false;
    /** @type {NonNullable<import('./types').SummaryOptions['dayCache']>} */
    this.dayCache = new WeakMap();
    /** @type {import('./types').DashboardSnapshot | null} */
    this.lastSnapshot = null;
    this.revision = 0;
    this.selectedDate = "";
    /** @type {{start: string, end: string} | null} */
    this.reportRange = null;
  }

  settings() {
    const config = this.vscode.workspace.getConfiguration("devstreak");
    const number = (key, fallback, min, max) => {
      const value = config.get(key, fallback);
      return typeof value === "number" && Number.isFinite(value)
        ? Math.max(min, Math.min(max, value)) : fallback;
    };
    const ignored = config.get("ignoredFolders", ["node_modules", ".git", "dist", "build"]);
    return {
      idleTimeoutMs: number("idleTimeoutMinutes", 5, 1, 60) * 60000,
      dailyGoalMinutes: number("dailyGoalMinutes", 60, 0, 1440),
      streakMinimumMinutes: number("streakMinimumMinutes", 15, 1, 1440),
      weekStartsOn: config.get("weekStartsOn", /** @type {string} */ ("monday")) === "sunday" ? 0 : 1,
      ignoredFolders: Array.isArray(ignored) ? ignored : [],
    };
  }

  async start() {
    const { vscode, context } = this;
    this.store = this.options.store || new ActivityStore({
      directory: context.globalStorageUri.fsPath,
      legacyData: context.globalState.get("devstreakData", {}),
    });
    try {
      this.data = await this.storageResult(() => this.store.init());
    } catch (error) {
      if (error.code !== "INVALID_STORAGE") throw error;
      this.recoveryRequired = true;
      this.lastError = error.message;
      vscode.window.showErrorMessage("DevStreak: " + error.message + " Run DevStreak: Recover History to restore or reset it.");
    }
    this.config = this.settings();
    this.paused = context.workspaceState.get("devstreakPaused", /** @type {boolean} */ (false)) === true;
    this.tracker = new ActiveTracker({
      idleTimeoutMs: this.config.idleTimeoutMs,
      now: this.now,
      onChange: (change) => {
        if (this.maintenance) return;
        this.pending.push(change);
        this.data = applyChanges(this.data, [change]);
      },
    });
    this.tracker.setPaused(this.paused || this.recoveryRequired);
    this.syncContext();
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
    this.statusBar.name = "DevStreak";
    this.statusBar.command = "devstreak.openActivity";
    this.statusBar.show();
    this.disposables.push(this.statusBar);

    const command = (name, callback) => this.disposables.push(
      vscode.commands.registerCommand("devstreak." + name, (...args) =>
        Promise.resolve().then(() => this.stopping ? undefined : callback(...args)).catch((error) => this.reportError(error))),
    );
    command("openActivity", () => this.openDashboard());
    command("togglePause", () => this.togglePause());
    command("openSettings", () => vscode.commands.executeCommand("workbench.action.openSettings", "@ext:Alwaystanishq.devstreak"));
    command("exportJson", () => this.exportData("json"));
    command("exportCsv", () => this.exportData("csv"));
    command("importJson", () => this.importData());
    command("clearHistory", () => this.clearHistory());
    command("recoverHistory", () => this.recoverHistory());

    this.disposables.push(
      vscode.window.onDidChangeWindowState(() => {
        this.syncContext();
        this.render();
        void this.flush().catch((error) => this.reportError(error));
      }),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.syncContext();
        this.tracker.activity();
        this.render();
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor !== vscode.window.activeTextEditor) return;
        if (![vscode.TextEditorSelectionChangeKind.Keyboard, vscode.TextEditorSelectionChangeKind.Mouse].includes(event.kind)) return;
        this.syncContext();
        this.tracker.activity();
        this.render();
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        if (event.textEditor !== vscode.window.activeTextEditor) return;
        this.syncContext();
        this.tracker.activity();
      }),
      vscode.workspace.onDidChangeTextDocument((event) => this.onEdit(event)),
      vscode.workspace.onDidOpenTextDocument((document) => {
        // Changing language mode closes and reopens the document. Settle the
        // old language's time without treating that change as user activity.
        if (document.uri.toString() !== vscode.window.activeTextEditor?.document.uri.toString()) return;
        this.syncContext(document);
        this.render();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("devstreak")) return;
        this.config = this.settings();
        this.tracker.configure({ idleTimeoutMs: this.config.idleTimeoutMs });
        this.syncContext();
        this.render();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.syncContext()),
    );
    if (this.options.timers !== false) {
      this.displayTimer = setInterval(() => { this.tracker.tick(); this.render(); }, 1000);
      this.saveTimer = setInterval(() => { void this.flush().catch((error) => this.reportError(error)); }, 5000);
    }
    context.subscriptions.push({ dispose: () => { void this.stop(); } });
    this.render();
  }

  syncContext(document = this.vscode.window.activeTextEditor?.document) {
    if (this.stopping) return;
    this.activeContext = documentContext(this.vscode, document, this.config.ignoredFolders);
    this.tracker.setContext({
      ...this.activeContext,
      focused: this.vscode.window.state.focused,
      active: this.vscode.window.state.active !== false,
    });
  }

  /** @param {import('vscode').TextDocumentChangeEvent} event */
  onEdit(event) {
    if (!event.contentChanges.length || this.maintenance || this.stopping || this.recoveryRequired) return;
    const editor = this.vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) return;
    this.syncContext();
    if (!this.activeContext.eligible) return;
    const characters = event.contentChanges.reduce((total, change) => total + Array.from(change.text).length, 0);
    this.tracker.edit({ characters, file: this.activeContext.file });
    this.render();
  }

  async storageResult(operation) {
    try {
      return await operation();
    } catch (error) {
      // Startup and reads can also succeed before failing to release a lock.
      // Preserve that result and allow the store to retry just the cleanup.
      if (!error.committedData) throw error;
      this.reportError(error);
      return error.committedData;
    }
  }

  async flush() {
    if (this.recoveryRequired) return;
    if (this.flushing) return this.flushing;
    this.tracker.tick();
    const batch = this.pending.splice(0);
    this.flushing = (async () => {
      try {
        const saved = await this.store.append(batch);
        this.data = applyChanges(saved, this.pending);
        this.lastError = "";
      } catch (error) {
        if (error instanceof StaleGenerationError) {
          // Another window replaced history. Old deltas must never resurrect it.
          this.pending = [];
          this.tracker.setPaused(true);
          this.pending = [];
          this.data = await this.storageResult(() => this.store.read());
          this.tracker.setPaused(this.paused || this.maintenance || this.stopping || this.recoveryRequired);
        } else if (error.committedData) {
          // The write succeeded but releasing the file lock failed. Retrying
          // this batch would count it twice; storage retries just the unlock.
          this.data = applyChanges(error.committedData, this.pending);
          this.reportError(error);
        } else {
          this.pending.unshift(...batch);
          throw error;
        }
      } finally {
        this.render();
      }
    })();
    try { await this.flushing; } finally { this.flushing = null; }
  }

  /** @returns {import('./types').DashboardSnapshot} */
  snapshot() {
    const today = localDateKey(new Date(this.now()));
    if (this.reportRange && this.reportRange.end > today) {
      this.reportRange = this.reportRange.start <= today ? { ...this.reportRange, end: today } : null;
    }
    const selectedDate = this.selectedDate && this.selectedDate <= today ? this.selectedDate : today;
    const all = summarize(this.data, { ...this.config, today, projectId: this.projectId,
      includeFilesForDate: selectedDate, dayCache: this.dayCache });
    if (this.projectId && !all.projects.some((project) => project.id === this.projectId)) {
      this.projectId = "";
      return this.snapshot();
    }
    return { type: "snapshot", today, status: this.tracker.status(), paused: this.paused,
      projectId: this.projectId, weekStartsOn: this.config.weekStartsOn, ...all,
      selectedDate, recoveryRequired: this.recoveryRequired, storageError: this.lastError,
      report: this.reportRange ? summarizeRange(this.data, this.reportRange.start, this.reportRange.end,
        { ...this.config, today, projectId: this.projectId }) : null };
  }

  render() {
    if (!this.statusBar || this.stopped) return;
    const today = localDateKey(new Date(this.now()));
    const status = this.tracker.status();
    const total = Object.values(this.data.days[today]?.projects || {}).reduce((sum, project) => sum + project.time, 0);
    const icon = status === "paused" ? "$(debug-pause)" : "$(watch)";
    const suffix = status === "paused" ? " · Paused" : status === "idle" ? " · Idle" : "";
    this.statusBar.text = this.recoveryRequired ? "$(warning) DevStreak · Recovery needed" : icon + " " + formatDuration(total) + suffix;
    this.statusBar.tooltip = "DevStreak · " + status + "\nToday: " + formatDuration(total)
      + "\nOpen activity, goals, and tracking controls." + (this.lastError ? "\nSave error: " + this.lastError : "");
    this.statusBar.accessibilityInformation = { label: this.statusBar.tooltip };
    if (this.panel?.visible && this.panelReady) {
      this.sendSnapshot();
    }
  }

  sendSnapshot() {
    const snapshot = this.snapshot();
    const previous = this.lastSnapshot;
    const revision = ++this.revision;
    /** @type {import('./types').DashboardMessage} */
    let message;
    if (!previous || previous.projectId !== snapshot.projectId) {
      message = { ...snapshot, revision };
    } else {
      const days = {};
      for (const [date, day] of Object.entries(snapshot.days)) {
        const old = previous.days[date];
        if (!old || old.time !== day.time || old.characters !== day.characters ||
          (old.files !== day.files && JSON.stringify(old.files) !== JSON.stringify(day.files))) days[date] = day;
      }
      const removedDays = Object.keys(previous.days).filter((date) => !Object.hasOwn(snapshot.days, date));
      const metadata = { ...snapshot };
      delete metadata.days;
      message = { ...metadata, type: "patch", days, removedDays, baseRevision: revision - 1, revision };
    }
    this.lastSnapshot = snapshot;
    void Promise.resolve(this.panel.webview.postMessage(message)).then((delivered) => {
      if (!delivered && this.revision === revision) this.lastSnapshot = null;
    }).catch(() => { this.lastSnapshot = null; });
  }

  openDashboard() {
    if (this.panel) { this.panel.reveal(); this.render(); return; }
    const { vscode, context } = this;
    this.panel = vscode.window.createWebviewPanel("devstreakActivity", "DevStreak Activity", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    const panel = this.panel;
    this.panelReady = false;
    this.lastSnapshot = null;
    const html = this.options.getWebviewHTML || require("./webview").getWebviewHTML;
    panel.webview.html = html(panel.webview, context.extensionUri);
    panel.onDidDispose(() => { if (this.panel === panel) this.panel = null; });
    panel.onDidChangeViewState(() => { if (panel.visible) this.render(); });
    panel.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message).catch((error) => this.reportError(error));
    });
  }

  async handleMessage(message) {
    if (!message || typeof message !== "object" || this.stopping) return;
    if (message.type === "ready") { this.panelReady = true; this.lastSnapshot = null; this.render(); return; }
    if (message.type === "selectDate") {
      if (isDateKey(message.date) && message.date <= localDateKey(new Date(this.now()))) {
        this.selectedDate = message.date;
        this.render();
      }
      return;
    }
    if (message.type === "report") {
      // Validate at the host boundary before retaining a webview request.
      summarizeRange(this.data, message.start, message.end,
        { ...this.config, today: localDateKey(new Date(this.now())), projectId: this.projectId });
      this.reportRange = { start: message.start, end: message.end };
      this.render();
      return;
    }
    if (message.type === "filter") {
      const projects = summarize(this.data, { ...this.config, today: localDateKey(new Date(this.now())),
        includeFilesForDate: "", dayCache: this.dayCache }).projects;
      if (message.projectId === "" || projects.some((project) => project.id === message.projectId)) {
        this.projectId = message.projectId;
        this.render();
      }
      return;
    }
    const commands = { togglePause: "togglePause", settings: "openSettings", exportJson: "exportJson", exportCsv: "exportCsv", importJson: "importJson", clearHistory: "clearHistory", recoverHistory: "recoverHistory" };
    if (Object.hasOwn(commands, message.type)) {
      await this.vscode.commands.executeCommand("devstreak." + commands[message.type]);
    }
  }

  async togglePause() {
    if (this.maintenance || this.stopping || this.recoveryRequired) return;
    this.paused = !this.paused;
    this.tracker.setPaused(this.paused || this.recoveryRequired);
    await this.context.workspaceState.update("devstreakPaused", this.paused);
    this.render();
    await this.flush();
  }

  async exportData(format) {
    if (this.maintenance || this.stopping || this.recoveryRequired) return;
    const { vscode } = this;
    const uri = await vscode.window.showSaveDialog({
      title: format === "json" ? "Back up DevStreak history" : "Export DevStreak CSV",
      saveLabel: "Export",
      filters: format === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
    });
    if (!uri || this.maintenance || this.stopping) return;
    await this.flush();
    const content = format === "json" ? encodeBackup(this.data) : Buffer.from(toCsv(this.data), "utf8");
    await vscode.workspace.fs.writeFile(uri, content);
    await vscode.window.showInformationMessage("DevStreak history exported.");
  }

  async importData() {
    if (this.maintenance || this.stopping) return;
    const { vscode } = this;
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ["json"] }, title: "Import DevStreak backup" });
    if (!selected?.length || this.maintenance || this.stopping) return;
    const stat = await vscode.workspace.fs.stat(selected[0]);
    checkBackupSize(stat.size);
    const contents = await vscode.workspace.fs.readFile(selected[0]);
    const backup = decodeBackup(contents);
    const accepted = await vscode.window.showWarningMessage(
      this.recoveryRequired
        ? "Restore this backup? The damaged storage file will be preserved before replacement. This affects all windows sharing this storage."
        : "Replace DevStreak history with this backup? This affects all windows sharing this storage. Export a backup first if you want to keep your current history.",
      { modal: true }, "Replace history",
    );
    if (accepted !== "Replace history" || this.maintenance || this.stopping) return;
    await this.replaceHistory(backup);
    await vscode.window.showInformationMessage("DevStreak backup imported.");
  }

  async clearHistory() {
    if (this.maintenance || this.stopping) return;
    const accepted = await this.vscode.window.showWarningMessage(
      this.recoveryRequired
        ? "Reset DevStreak history? The damaged storage file will be preserved before replacement. This affects all windows sharing this storage."
        : "Clear all DevStreak history? This affects all windows sharing this storage and cannot be undone. Export a backup first to keep a copy.",
      { modal: true }, "Clear history",
    );
    if (accepted !== "Clear history" || this.maintenance || this.stopping) return;
    await this.replaceHistory(null);
    await this.vscode.window.showInformationMessage("DevStreak history cleared.");
  }

  async replaceHistory(backup) {
    if (this.maintenance || this.stopping) return;
    this.tracker.setPaused(true);
    this.maintenance = true;
    try {
      await this.flush();
      if (this.pending.length) await this.flush();
      try {
        this.data = this.recoveryRequired ? await this.store.recover(backup || emptyData())
          : backup ? await this.store.replace(backup) : await this.store.clear();
      } catch (error) {
        if (!error.committedData) throw error;
        this.data = error.committedData;
        this.reportError(error);
      }
      this.pending = [];
      this.recoveryRequired = false;
      this.lastError = "";
      this.lastSnapshot = null;
      this.projectId = "";
      await this.context.globalState.update("devstreakData", undefined);
    } finally {
      this.maintenance = false;
      this.tracker.setPaused(this.paused || this.stopping || this.recoveryRequired);
      this.render();
    }
  }

  async recoverHistory() {
    if (this.maintenance || this.stopping) return;
    const choice = await this.vscode.window.showQuickPick(["Retry loading", "Restore JSON backup", "Reset history"],
      { title: "Recover DevStreak history", placeHolder: "Damaged storage is preserved before restore or reset." });
    if (this.maintenance || this.stopping) return;
    if (choice === "Restore JSON backup") return this.importData();
    if (choice === "Reset history") return this.clearHistory();
    if (choice !== "Retry loading") return;
    this.tracker.setPaused(true);
    this.maintenance = true;
    try {
      await this.flush();
      this.data = await this.storageResult(() => this.store.init());
      this.pending = [];
      this.recoveryRequired = false;
      this.lastError = "";
      this.lastSnapshot = null;
    } finally {
      this.maintenance = false;
      this.tracker.setPaused(this.paused || this.stopping || this.recoveryRequired);
      this.render();
    }
  }

  reportError(error) {
    if (error?.code === "INVALID_STORAGE" && this.tracker) {
      this.recoveryRequired = true;
      this.tracker.setPaused(true);
    }
    const message = error?.message || String(error);
    if (this.lastError !== message) this.vscode.window.showErrorMessage("DevStreak: " + message);
    this.lastError = message;
    this.render();
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopped) return Promise.resolve();
    this.stopping = true;
    clearInterval(this.displayTimer);
    clearInterval(this.saveTimer);
    this.tracker.setPaused(true);
    this.stopPromise = (async () => {
      try {
        await this.flush();
        if (this.pending.length) await this.flush();
      } catch (error) {
        this.reportError(error);
      } finally { this.dispose(); }
    })();
    return this.stopPromise;
  }

  dispose() {
    this.stopped = true;
    clearInterval(this.displayTimer);
    clearInterval(this.saveTimer);
    this.panel?.dispose();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }
}

module.exports = { ActivityController };
