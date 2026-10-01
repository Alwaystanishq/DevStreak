const { ActivityStore, StaleGenerationError } = require("./storage");
const { ActiveTracker } = require("./tracker");
const { emptyData, applyChanges, summarize, localDateKey, formatDuration, validateData, toCsv } = require("./model");
const { documentContext } = require("./context");

class ActivityController {
  constructor(vscode, context, options = {}) {
    this.vscode = vscode;
    this.context = context;
    this.options = options;
    this.now = options.now || Date.now;
    this.data = emptyData();
    this.pending = [];
    this.projectId = "";
    this.panel = null;
    this.disposables = [];
    this.stopped = false;
    this.maintenance = false;
    this.lastError = "";
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
      weekStartsOn: config.get("weekStartsOn", "monday") === "sunday" ? 0 : 1,
      ignoredFolders: Array.isArray(ignored) ? ignored : [],
    };
  }

  async start() {
    const { vscode, context } = this;
    this.store = this.options.store || new ActivityStore({
      directory: context.globalStorageUri.fsPath,
      legacyData: context.globalState.get("devstreakData", {}),
    });
    this.data = await this.storageResult(() => this.store.init());
    this.config = this.settings();
    this.paused = context.workspaceState.get("devstreakPaused", false) === true;
    this.tracker = new ActiveTracker({
      idleTimeoutMs: this.config.idleTimeoutMs,
      now: this.now,
      onChange: (change) => {
        if (this.maintenance) return;
        this.pending.push(change);
        this.data = applyChanges(this.data, [change]);
      },
    });
    this.tracker.setPaused(this.paused);
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

  syncContext() {
    if (this.stopping) return;
    const document = this.vscode.window.activeTextEditor?.document;
    this.activeContext = documentContext(this.vscode, document, this.config.ignoredFolders);
    this.tracker.setContext({
      ...this.activeContext,
      focused: this.vscode.window.state.focused,
      active: this.vscode.window.state.active !== false,
    });
  }

  onEdit(event) {
    if (!event.contentChanges.length || this.maintenance || this.stopping) return;
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
          this.tracker.setPaused(this.paused || this.maintenance || this.stopping);
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

  snapshot() {
    const today = localDateKey(new Date(this.now()));
    const all = summarize(this.data, { ...this.config, today, projectId: this.projectId });
    if (this.projectId && !all.projects.some((project) => project.id === this.projectId)) {
      this.projectId = "";
      return this.snapshot();
    }
    return { type: "snapshot", today, status: this.tracker.status(), paused: this.paused,
      projectId: this.projectId, weekStartsOn: this.config.weekStartsOn, ...all };
  }

  render() {
    if (!this.statusBar || this.stopped) return;
    const snapshot = this.snapshot();
    // The status bar always describes all projects, independent of dashboard filters.
    const total = summarize(this.data, { ...this.config, today: snapshot.today }).summary.todaySeconds;
    const icon = snapshot.status === "paused" ? "$(debug-pause)" : "$(watch)";
    const suffix = snapshot.status === "paused" ? " · Paused" : snapshot.status === "idle" ? " · Idle" : "";
    this.statusBar.text = icon + " " + formatDuration(total) + suffix;
    this.statusBar.tooltip = "DevStreak · " + snapshot.status + "\nToday: " + formatDuration(total)
      + "\nOpen activity, goals, and tracking controls." + (this.lastError ? "\nSave error: " + this.lastError : "");
    this.statusBar.accessibilityInformation = { label: this.statusBar.tooltip };
    if (this.panel?.visible && this.panelReady) {
      void Promise.resolve(this.panel.webview.postMessage(snapshot)).catch(() => {});
    }
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
    if (message.type === "ready") { this.panelReady = true; this.render(); return; }
    if (message.type === "filter") {
      const projects = summarize(this.data, { ...this.config, today: localDateKey(new Date(this.now())) }).projects;
      if (message.projectId === "" || projects.some((project) => project.id === message.projectId)) {
        this.projectId = message.projectId;
        this.render();
      }
      return;
    }
    const commands = { togglePause: "togglePause", settings: "openSettings", exportJson: "exportJson", exportCsv: "exportCsv", importJson: "importJson", clearHistory: "clearHistory" };
    if (Object.hasOwn(commands, message.type)) {
      await this.vscode.commands.executeCommand("devstreak." + commands[message.type]);
    }
  }

  async togglePause() {
    if (this.maintenance || this.stopping) return;
    this.paused = !this.paused;
    this.tracker.setPaused(this.paused);
    await this.context.workspaceState.update("devstreakPaused", this.paused);
    this.render();
    await this.flush();
  }

  async exportData(format) {
    if (this.maintenance || this.stopping) return;
    const { vscode } = this;
    const uri = await vscode.window.showSaveDialog({
      title: format === "json" ? "Back up DevStreak history" : "Export DevStreak CSV",
      saveLabel: "Export",
      filters: format === "json" ? { JSON: ["json"] } : { CSV: ["csv"] },
    });
    if (!uri || this.maintenance || this.stopping) return;
    await this.flush();
    const content = format === "json" ? JSON.stringify(validateData(this.data), null, 2) : toCsv(this.data);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
    await vscode.window.showInformationMessage("DevStreak history exported.");
  }

  async importData() {
    if (this.maintenance || this.stopping) return;
    const { vscode } = this;
    const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { JSON: ["json"] }, title: "Import DevStreak backup" });
    if (!selected?.length || this.maintenance || this.stopping) return;
    const stat = await vscode.workspace.fs.stat(selected[0]);
    if (stat.size > 20 * 1024 * 1024) throw new Error("The backup is larger than the 20 MB import limit.");
    const contents = await vscode.workspace.fs.readFile(selected[0]);
    if (contents.byteLength > 20 * 1024 * 1024) throw new Error("The backup is larger than the 20 MB import limit.");
    const backup = validateData(JSON.parse(Buffer.from(contents).toString("utf8")));
    const accepted = await vscode.window.showWarningMessage(
      "Replace DevStreak history with this backup? This affects all windows sharing this storage. Export a backup first if you want to keep your current history.",
      { modal: true }, "Replace history",
    );
    if (accepted !== "Replace history" || this.maintenance || this.stopping) return;
    await this.replaceHistory(backup);
    await vscode.window.showInformationMessage("DevStreak backup imported.");
  }

  async clearHistory() {
    if (this.maintenance || this.stopping) return;
    const accepted = await this.vscode.window.showWarningMessage(
      "Clear all DevStreak history? This affects all windows sharing this storage and cannot be undone. Export a backup first to keep a copy.",
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
        this.data = backup ? await this.store.replace(backup) : await this.store.clear();
      } catch (error) {
        if (!error.committedData) throw error;
        this.data = error.committedData;
        this.reportError(error);
      }
      this.pending = [];
      this.projectId = "";
      await this.context.globalState.update("devstreakData", undefined);
    } finally {
      this.maintenance = false;
      this.tracker.setPaused(this.paused || this.stopping);
      this.render();
    }
  }

  reportError(error) {
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
