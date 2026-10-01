const vscode = require("vscode");
const { ActivityController } = require("./src/controller");

let controller;
async function activate(context) {
  controller = new ActivityController(vscode, context);
  try {
    await controller.start();
  } catch (error) {
    controller.dispose();
    controller = undefined;
    vscode.window.showErrorMessage("DevStreak could not start: " + error.message);
  }
}
async function deactivate() {
  if (controller) {
    await controller.stop();
    controller = undefined;
  }
}
module.exports = { activate, deactivate };
