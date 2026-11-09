import { defineConfig, devices } from '@playwright/test';
import { config } from 'dotenv';
import path from 'node:path';

// The specs read TEST_DATABASE_URL to check postings behind the screen.
config({ path: path.resolve(__dirname, '../.env'), quiet: true });

// One worker: the trap spec wipes factory_test before it runs.
export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3140',
    ...devices['Pixel 7'],
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/stack.cjs',
      url: 'http://127.0.0.1:4120/health',
      timeout: 180_000,
      reuseExistingServer: false,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'npx next dev -p 3140',
      url: 'http://localhost:3140',
      timeout: 120_000,
      reuseExistingServer: false,
      env: { NEXT_PUBLIC_TRAP_DROP_MS: '3000', NEXT_PUBLIC_API_URL: 'http://localhost:4120' },
    },
  ],
});
