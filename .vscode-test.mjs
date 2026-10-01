import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test/extension.test.js',
  useInstallation: process.env.DEVSTREAK_VSCODE_EXECUTABLE
    ? { fromPath: process.env.DEVSTREAK_VSCODE_EXECUTABLE }
    : undefined,
  launchArgs: ['--disable-extensions', '--skip-welcome', '--skip-release-notes'],
  mocha: { timeout: 15000 },
});
