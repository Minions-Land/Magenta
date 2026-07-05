import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Sequential for CLI/TUI tests
  reporter: 'html',
  timeout: 60000,

  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'cli-conversation',
      testMatch: '**/cli-conversation.test.ts',
      timeout: 60000, // Longer timeout for real API calls
    },
    {
      name: 'tui-tests',
      testMatch: '**/tui.test.ts',
      timeout: 90000, // Real PTY boot + streaming API calls
    },
    {
      name: 'lazypi-tests',
      testMatch: '**/lazypi.test.ts',
    },
  ],
});
