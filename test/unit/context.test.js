const test = require("node:test");
const assert = require("node:assert/strict");
const { isIgnored, documentContext } = require("../../src/context");

test("folder exclusions match complete path segments, not similarly named files", () => {
  assert.equal(isIgnored("src/node_modules/pkg/index.js", ["node_modules"]), true);
  assert.equal(isIgnored("src/generated/index.js", ["src/generated"]), true);
  assert.equal(isIgnored("src/generated-other/index.js", ["src/generated"]), false);
  assert.equal(isIgnored("src/build.js", ["build"]), false);
  assert.equal(isIgnored("src\\build\\index.js", ["build"]), true);
  assert.equal(isIgnored("src/index.js", ["", null]), false);
});

test("remote files keep their URI identity and workspace-relative paths", () => {
  const uri = { scheme: "vscode-remote", path: "/work/app/src/index.js", toString: () => "vscode-remote://ssh-host/work/app/src/index.js" };
  const folder = { name: "app", uri: { path: "/work/app", toString: () => "vscode-remote://ssh-host/work/app" } };
  const result = documentContext({ workspace: { getWorkspaceFolder: () => folder } }, { uri, languageId: "javascript" }, []);
  assert.equal(result.eligible, true);
  assert.equal(result.file.path, "src/index.js");
  assert.equal(result.file.id, uri.toString());
  assert.equal(result.projectId, folder.uri.toString());
  assert.equal(result.languageId, "javascript");
});

test("language follows editor mode for untitled files and custom languages", () => {
  const uri = { scheme: "untitled", path: "/Untitled-1.py", toString: () => "untitled:Untitled-1.py" };
  const vscode = { workspace: { getWorkspaceFolder: () => undefined } };
  assert.equal(documentContext(vscode, { uri, languageId: "custom-dsl" }, []).languageId, "custom-dsl");
  assert.equal(documentContext(vscode, { uri }, []).languageId, "unknown");
});

test("output and preview documents are not tracked", () => {
  assert.equal(documentContext({}, { uri: { scheme: "output" } }, []).eligible, false);
  assert.equal(documentContext({}, undefined, []).eligible, false);
});
