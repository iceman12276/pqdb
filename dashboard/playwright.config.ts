import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: "cd ../backend && uv run uvicorn pqdb_api.app:create_app --factory --port 8000",
      port: 8000,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL ?? "postgresql+asyncpg://postgres:postgres@localhost:5432/pqdb_platform",
        VAULT_ADDR: process.env.VAULT_ADDR ?? "http://localhost:8200",
        VAULT_TOKEN: process.env.VAULT_TOKEN ?? "dev-root-token",
        WEBAUTHN_ORIGIN: process.env.WEBAUTHN_ORIGIN ?? "http://localhost:3000",
      },
    },
    {
      command: "npm run dev",
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
