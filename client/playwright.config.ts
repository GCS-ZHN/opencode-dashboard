import { defineConfig, devices } from "@playwright/test";

const MOCK_PORT = 5299;
const PORT = 5282;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "bun run mock-backend.ts",
      env: { PORT: String(MOCK_PORT), MOCK_LATENCY: "120" },
      port: MOCK_PORT,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `bun run build && DASHBOARD_CONFIG=e2e/config.none.yaml node dist-cli/cli.mjs serve --port ${PORT}`,
      port: PORT,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
