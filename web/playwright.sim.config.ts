import { defineConfig } from '@playwright/test';
import base from './playwright.config';

type Servers = Extract<NonNullable<typeof base.webServer>, unknown[]>;

// The trap beside a running simulated line, which the default config keeps
// off. A 300 ms tick gives the sim many moves inside the trap's 3 s drop, so
// a sim that reaches for the visitor's bundle does it during the run.
const [stack, web] = base.webServer as Servers;

export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: /live-sim\.spec\.ts/,
  webServer: [{ ...stack, env: { STACK_SIM: '1', SIM_TICK_MS: '300' } }, web],
});
