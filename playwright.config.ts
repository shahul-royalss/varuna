import { defineConfig, devices } from "@playwright/test";

// `make e2e` (= `uv run varuna e2e`) runs `pnpm exec playwright test` from the repo root.
// Both servers are started here so the demo test needs no terminal; an already running
// `make dev` / `make demo` pair is reused instead.
const UI_URL = process.env.PLAYWRIGHT_UI_URL ?? "http://localhost:3000";
const API_URL = process.env.PLAYWRIGHT_API_URL ?? "http://localhost:8000";

export default defineConfig({
  testDir: "./tests/e2e",
  // The demo test walks eleven screens, each of which may be compiled by Turbopack on first
  // visit and served by an API waking from sleep.
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"]],
  outputDir: "./test-results",
  use: {
    baseURL: UI_URL,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
    colorScheme: "dark",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
  webServer: [
    {
      command: "uv run uvicorn varuna_api.main:app --host 127.0.0.1 --port 8000",
      url: `${API_URL}/healthz`,
      reuseExistingServer: true,
      timeout: 120_000,
      env: { VARUNA_MODE: "replay", VARUNA_REPLAY_AUTOPLAY: "0" },
    },
    {
      command: "pnpm --filter @varuna/command dev",
      url: UI_URL,
      reuseExistingServer: true,
      timeout: 180_000,
      env: {
        NEXT_PUBLIC_API_URL: API_URL,
        NEXT_PUBLIC_WS_URL: `${API_URL.replace(/^http/, "ws")}/v1/live`,
      },
    },
  ],
});
