const assert = require("node:assert/strict");
const vscode = require("vscode");

suite("DevStreak extension host", () => {
  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension("Alwaystanishq.devstreak");
    assert.ok(extension, "DevStreak must be installed in the test host");
    await extension.activate();
    assert.equal(extension.isActive, true);
  });

  test("registers every contributed command", async () => {
    const commands = await vscode.commands.getCommands(true);
    const manifest = require("../package.json");
    for (const { command } of manifest.contributes.commands) {
      assert.ok(commands.includes(command), command + " must be registered");
    }
  });

  test("opens and reuses the activity panel", async () => {
    await vscode.commands.executeCommand("devstreak.openActivity");
    await vscode.commands.executeCommand("devstreak.openActivity");
    const panels = vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .filter((tab) => tab.label === "DevStreak Activity");
    assert.equal(panels.length, 1);
    await vscode.window.tabGroups.close(panels);
  });

  test("pause and resume commands work", async () => {
    await vscode.commands.executeCommand("devstreak.togglePause");
    await vscode.commands.executeCommand("devstreak.togglePause");
  });
});
