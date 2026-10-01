const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ActivityController } = require("../../src/controller");
const { ActivityStore } = require("../../src/storage");
const { summarize, localDateKey } = require("../../src/model");

function event() {
  const listeners = new Set();
  const subscribe = (callback) => {
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  };
  subscribe.fire = (value) => { for (const callback of listeners) callback(value); };
  return subscribe;
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "devstreak-controller-"));
  const commands = new Map();
  const messages = [];
  const errors = [];
  const state = new Map();
  const uri = (value) => ({ scheme: "file", path: value, fsPath: value, toString: () => "file://" + value });
  const editor = { document: { uri: uri("/work/app/src/index.js"), fileName: "/work/app/src/index.js" } };
  const panel = {
    visible: true, reveal() {}, onDidDispose: event(), onDidChangeViewState: event(),
    dispose() { this.onDidDispose.fire(); },
    webview: { html: "", onDidReceiveMessage: event(), postMessage: async (message) => { messages.push(message); return true; } },
  };
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ViewColumn: { Active: -1 },
    TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
    Uri: { joinPath: (base, segment) => uri(base.path + "/" + segment) },
    commands: {
      registerCommand: (name, callback) => { commands.set(name, callback); return { dispose: () => commands.delete(name) }; },
      executeCommand: async (name, ...args) => commands.get(name)?.(...args),
    },
    window: {
      activeTextEditor: editor, state: { focused: true, active: true },
      createStatusBarItem: () => ({ show() {}, dispose() {} }),
      onDidChangeWindowState: event(), onDidChangeActiveTextEditor: event(),
      onDidChangeTextEditorSelection: event(), onDidChangeTextEditorVisibleRanges: event(),
      createWebviewPanel: () => panel,
      showErrorMessage: (message) => errors.push(message),
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => {},
    },
    workspace: {
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
      getWorkspaceFolder: () => ({ name: "app", uri: uri("/work/app") }),
      onDidChangeTextDocument: event(), onDidChangeConfiguration: event(), onDidChangeWorkspaceFolders: event(),
    },
  };
  const context = {
    globalStorageUri: uri(directory), extensionUri: uri("/extension"), subscriptions: [],
    globalState: { get: (_key, fallback) => fallback, update: async () => {} },
    workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => state.set(key, value) },
  };
  let now = options.now ?? new Date().setHours(12, 0, 0, 0);
  const controller = new ActivityController(vscode, context, {
    ...options, timers: false, now: () => now, getWebviewHTML: () => "<html></html>",
  });
  await controller.start();
  t.after(async () => {
    await controller.stop();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const edit = (text) => vscode.workspace.onDidChangeTextDocument.fire({ document: editor.document, contentChanges: [{ text }] });
  const advance = (ms) => { now += ms; controller.tracker.tick(); controller.render(); };
  return { controller, vscode, context, edit, advance, panel, messages, errors, commands, directory, editor };
}

test("activation does not create activity; edits count Unicode characters and update an open dashboard", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.controller.data.days, {});
  await f.commands.get("devstreak.openActivity")();
  await f.controller.handleMessage({ type: "ready" });
  f.edit("a🔥");
  f.advance(1000);
  const today = f.messages.at(-1).days[localDateKey()];
  assert.equal(today.characters, 2);
  assert.equal(today.time, 1);
  assert.equal(today.files[0].path, "src/index.js");
  assert.equal(f.messages.at(-1).status, "tracking");
  await f.controller.flush();
  assert.equal(summarize(await f.controller.store.read()).summary.todaySeconds, 1);
  assert.deepEqual(f.errors, []);
});

test("focus loss, pause, excluded folders, background edits and empty events do not accrue activity", async (t) => {
  const f = await fixture(t);
  f.edit("x");
  f.advance(1000);
  f.vscode.window.state.focused = false;
  f.vscode.window.onDidChangeWindowState.fire();
  f.edit("ignored");
  f.advance(1000);
  f.vscode.window.state.focused = true;
  f.controller.syncContext();
  await f.controller.togglePause();
  f.edit("paused");
  f.advance(1000);
  await f.controller.togglePause();
  f.vscode.workspace.onDidChangeTextDocument.fire({ document: f.editor.document, contentChanges: [] });
  f.vscode.workspace.onDidChangeTextDocument.fire({ document: { uri: { toString: () => "file:///another.js" } }, contentChanges: [{ text: "background" }] });
  f.editor.document.uri.path = "/work/app/node_modules/pkg/index.js";
  f.edit("excluded");
  const day = summarize(f.controller.data).days[localDateKey()];
  assert.equal(day.time, 1);
  assert.equal(day.characters, 1);
});

test("VS Code inactivity freezes the timer, rejects automatic edits, and persists only active time", async (t) => {
  const f = await fixture(t);
  f.edit("x");
  f.advance(1000);
  f.vscode.window.state.active = false;
  f.vscode.window.onDidChangeWindowState.fire();
  f.edit("automatic changes while idle");
  for (let i = 0; i < 600; i++) f.advance(1000);
  assert.equal(f.controller.snapshot().status, "idle");
  assert.ok(f.controller.statusBar.text.endsWith("00:00:01 · Idle"));
  await f.controller.flush();
  const saved = summarize(await f.controller.store.read()).days[localDateKey()];
  assert.equal(saved.time, 1);
  assert.equal(saved.characters, 1);
  f.vscode.window.state.active = true;
  f.vscode.window.onDidChangeWindowState.fire();
  f.edit("y");
  f.advance(1000);
  assert.equal(f.controller.snapshot().summary.todaySeconds, 2);
});

test("configured inactivity cutoff also freezes focused active windows and resumes without idle backfill", async (t) => {
  const f = await fixture(t);
  f.edit("x");
  for (let i = 0; i < 600; i++) f.advance(1000);
  assert.equal(f.controller.snapshot().status, "idle");
  assert.equal(f.controller.snapshot().summary.todaySeconds, 300);
  assert.ok(f.controller.statusBar.text.endsWith("00:05:00 · Idle"));
  await f.controller.flush();
  f.edit("y");
  f.advance(1000);
  assert.equal(f.controller.snapshot().summary.todaySeconds, 301);
});

test("a failed save retains deltas and retry saves them once", async (t) => {
  const f = await fixture(t);
  f.edit("abc");
  const append = f.controller.store.append.bind(f.controller.store);
  f.controller.store.append = async () => { throw new Error("disk unavailable"); };
  await assert.rejects(f.controller.flush(), /disk unavailable/);
  assert.equal(f.controller.pending.length, 1);
  f.controller.store.append = append;
  await f.controller.flush();
  assert.equal(f.controller.pending.length, 0);
  assert.equal(summarize(await f.controller.store.read()).days[localDateKey()].characters, 3);
});

test("in-flight saves preserve edits arriving before the save resolves", async (t) => {
  const f = await fixture(t);
  f.edit("first");
  const append = f.controller.store.append.bind(f.controller.store);
  let release;
  f.controller.store.append = async (changes) => {
    await new Promise((resolve) => { release = resolve; });
    return append(changes);
  };
  const saving = f.controller.flush();
  f.edit("second");
  release();
  await saving;
  assert.equal(summarize(f.controller.data).days[localDateKey()].characters, 11);
  f.controller.store.append = append;
  await f.controller.flush();
  assert.equal(summarize(await f.controller.store.read()).days[localDateKey()].characters, 11);
});

test("history cleared in another window cannot be resurrected by pending edits", async (t) => {
  const f = await fixture(t);
  f.edit("old");
  const other = new ActivityStore({ directory: f.directory });
  await other.init();
  await other.clear();
  await f.controller.flush();
  assert.deepEqual(f.controller.data.days, {});
  assert.equal(f.controller.pending.length, 0);
  f.edit("new");
  await f.controller.flush();
  assert.equal(summarize(await other.read()).days[localDateKey()].characters, 3);
});

test("clear requires confirmation, removes legacy history, and resets the filter", async (t) => {
  const f = await fixture(t);
  f.edit("keep");
  await f.controller.clearHistory();
  assert.ok(Object.keys(f.controller.data.days).length);
  let removed;
  f.context.globalState.update = async (key, value) => { removed = { key, value }; };
  f.vscode.window.showWarningMessage = async () => "Clear history";
  f.controller.projectId = "file:///work/app";
  await f.controller.clearHistory();
  assert.deepEqual(f.controller.data.days, {});
  assert.equal(f.controller.projectId, "");
  assert.deepEqual(removed, { key: "devstreakData", value: undefined });
});

test("unknown dashboard messages and filters cannot invoke arbitrary commands", async (t) => {
  const f = await fixture(t);
  await f.controller.handleMessage({ type: "constructor" });
  await f.controller.handleMessage({ type: "filter", projectId: "__proto__" });
  assert.equal(f.controller.projectId, "");
  assert.deepEqual(f.errors, []);
});

test("dashboard and status bar roll over using the same local clock as tracking", async (t) => {
  const start = new Date(2026, 9, 2, 23, 59, 59).getTime();
  const f = await fixture(t, { now: start });
  f.edit("x");
  f.advance(2000);
  const snapshot = f.controller.snapshot();
  assert.equal(snapshot.today, "2026-10-03");
  assert.equal(snapshot.days["2026-10-02"].time, 1);
  assert.equal(snapshot.days["2026-10-03"].time, 1);
  assert.equal(snapshot.summary.todaySeconds, 1);
  assert.ok(f.controller.statusBar.text.endsWith("00:00:01"));
});

test("a committed save with a cleanup error is acknowledged and never replayed", async (t) => {
  const f = await fixture(t);
  f.edit("abc");
  const append = f.controller.store.append.bind(f.controller.store);
  f.controller.store.append = async (changes) => {
    const committedData = await append(changes);
    const error = new Error("unlock failed");
    error.committedData = committedData;
    throw error;
  };
  await f.controller.flush();
  assert.equal(f.controller.pending.length, 0);
  assert.ok(f.errors.some((message) => message.includes("unlock failed")));
  f.controller.store.append = append;
  await f.controller.flush();
  assert.equal(summarize(await f.controller.store.read()).days[localDateKey()].characters, 3);
});

test("shutdown is single-flight, saves final activity, and blocks further edits", async (t) => {
  const f = await fixture(t);
  f.edit("final");
  f.advance(1000);
  const first = f.controller.stop();
  const second = f.controller.stop();
  assert.equal(first, second);
  f.edit("ignored");
  await first;
  const day = summarize(await f.controller.store.read()).days[localDateKey()];
  assert.equal(day.characters, 5);
  assert.equal(day.time, 1);
  assert.equal(f.commands.size, 0);
  assert.equal(f.controller.stopped, true);
});

test("stale history recovery never resumes tracking during shutdown", async (t) => {
  const f = await fixture(t);
  f.edit("old");
  const other = new ActivityStore({ directory: f.directory });
  await other.init();
  await other.clear();
  await f.controller.stop();
  assert.equal(f.controller.tracker.status(), "paused");
  assert.deepEqual((await other.read()).days, {});
});

test("startup keeps committed history when releasing the initial storage lock fails", async (t) => {
  const data = { version: 2, days: {} };
  const store = {
    init: async () => {
      const error = new Error("initial unlock failed");
      error.committedData = data;
      throw error;
    },
    append: async () => data,
  };
  const f = await fixture(t, { store });
  assert.deepEqual(f.controller.data, data);
  assert.ok(f.commands.has("devstreak.openActivity"));
  assert.ok(f.errors.some((error) => error.includes("initial unlock failed")));
  f.edit("x");
  assert.equal(f.controller.snapshot().status, "tracking");
});

test("recovery keeps a committed read and resumes after a cleanup error", async (t) => {
  const f = await fixture(t);
  f.edit("old");
  const other = new ActivityStore({ directory: f.directory });
  await other.init();
  await other.clear();
  const read = f.controller.store.read.bind(f.controller.store);
  f.controller.store.read = async () => {
    const committedData = await read();
    const error = new Error("recovery unlock failed");
    error.committedData = committedData;
    throw error;
  };
  await f.controller.flush();
  assert.deepEqual(f.controller.data.days, {});
  assert.equal(f.controller.tracker.status(), "idle");
  assert.ok(f.errors.some((error) => error.includes("recovery unlock failed")));
  f.controller.store.read = read;
  f.edit("new");
  f.advance(1000);
  await f.controller.flush();
  assert.equal(f.controller.snapshot().status, "tracking");
  assert.equal(summarize(await other.read()).days[localDateKey()].characters, 3);
  assert.equal(summarize(await other.read()).days[localDateKey()].time, 1);
});

test("export ignores the project filter and produces a validated backup", async (t) => {
  const f = await fixture(t);
  f.edit("abc");
  f.controller.projectId = "file:///work/app";
  const output = { path: "/backup.json" };
  let content;
  f.vscode.window.showSaveDialog = async () => output;
  f.vscode.workspace.fs = { writeFile: async (uri, bytes) => { assert.equal(uri, output); content = Buffer.from(bytes).toString(); } };
  await f.controller.exportData("json");
  const backup = JSON.parse(content);
  assert.equal(backup.version, 2);
  assert.equal(backup.days[localDateKey()].projects["file:///work/app"].characters, 3);
  const csvOutput = [];
  f.vscode.workspace.fs.writeFile = async (_uri, bytes) => csvOutput.push(Buffer.from(bytes).toString());
  await f.controller.exportData("csv");
  assert.ok(csvOutput[0].includes('"Characters added"'));
  assert.ok(csvOutput[0].includes('"src/index.js"'));
});

test("invalid and oversized imports preserve history without requesting replacement", async (t) => {
  const f = await fixture(t);
  f.edit("keep");
  const before = JSON.stringify(f.controller.data);
  f.vscode.window.showOpenDialog = async () => [{ path: "/invalid.json" }];
  let confirmations = 0;
  f.vscode.window.showWarningMessage = async () => { confirmations++; return "Replace history"; };
  f.vscode.workspace.fs = {
    stat: async () => ({ size: 3 }),
    readFile: async () => Buffer.from('{"version":99,"days":{}}'),
  };
  await assert.rejects(f.controller.importData(), /Unsupported backup version/);
  f.vscode.workspace.fs.stat = async () => ({ size: 21 * 1024 * 1024 });
  await assert.rejects(f.controller.importData(), /20 MB/);
  assert.equal(confirmations, 0);
  assert.equal(JSON.stringify(f.controller.data), before);
});

test("confirmed import replaces history and discards the old pending activity", async (t) => {
  const f = await fixture(t);
  f.edit("old");
  const backup = { version: 2, days: {
    "2026-01-01": { projects: { imported: { name: "Restored", time: 120, characters: 7, files: {} } } },
  } };
  f.vscode.window.showOpenDialog = async () => [{ path: "/backup.json" }];
  f.vscode.window.showWarningMessage = async () => "Replace history";
  f.vscode.workspace.fs = {
    stat: async () => ({ size: 100 }),
    readFile: async () => Buffer.from(JSON.stringify(backup)),
  };
  await f.controller.importData();
  assert.deepEqual(f.controller.data, backup);
  assert.equal(f.controller.pending.length, 0);
  assert.equal(f.controller.tracker.status(), "idle");
  await f.controller.flush();
  assert.deepEqual(await f.controller.store.read(), backup);
});
