/**
 * Test 6 — Key management UX
 *
 * Encryption key warning appears in SDK console, Dashboard settings page
 * shows encryption section.
 */
import { test, expect } from "@playwright/test";
import {
  testEmail,
  apiSignup,
  apiCreateProject,
  apiCreateTable,
  injectTokens,
  mockProjectKeys,
} from "./helpers";

const PASSWORD = "TestPassword123!";
const BASE_URL = "http://localhost:8000";

test.describe("Key management UX", () => {
  let accessToken: string;
  let refreshToken: string;
  let projectId: string;
  let serviceRoleKey: string;

  test.beforeAll(async () => {
    const email = testEmail();
    const tokens = await apiSignup(BASE_URL, email, PASSWORD);
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;

    const project = await apiCreateProject(BASE_URL, accessToken, `keys-e2e-${Date.now()}`);
    projectId = project.id;
    serviceRoleKey = project.api_keys.find((k) => k.role === "service")!.key;

    // Create a table with encrypted columns (triggers encryption key UX)
    await apiCreateTable(BASE_URL, serviceRoleKey, "secrets", [
      { name: "secret_id", data_type: "uuid", sensitivity: "plain", owner: true },
      { name: "secret_value", data_type: "text", sensitivity: "private" },
    ]);
  });

  test("Dashboard settings page shows encryption section with key info", async ({ page }) => {
    await page.goto("/login", { waitUntil: "networkidle" });
    await injectTokens(page, accessToken, refreshToken);
    await page.goto(`/projects/${projectId}/settings`);

    // Wait for the settings page
    await expect(page.getByText("Project Settings")).toBeVisible({ timeout: 15_000 });

    // Encryption section should be visible
    await expect(page.getByRole("heading", { name: "Encryption" })).toBeVisible();
    await expect(page.getByText("Zero-Knowledge Architecture")).toBeVisible();

    // Key type info
    await expect(page.getByText("ML-KEM-768")).toBeVisible();

    // Key backup recommendations
    await expect(page.getByText("Key Backup Recommendations")).toBeVisible();
    await expect(page.getByText("Password manager", { exact: true })).toBeVisible();
    await expect(page.getByText("Secure vault", { exact: true })).toBeVisible();
    await expect(page.getByText("Offline backup", { exact: true })).toBeVisible();

    // Warning about key loss
    await expect(
      page.getByText("permanently unrecoverable"),
    ).toBeVisible();
  });

  test("encryption key warning appears in unlock dialog", async ({ page }) => {
    await page.goto("/login", { waitUntil: "networkidle" });
    await injectTokens(page, accessToken, refreshToken);
    await mockProjectKeys(page, projectId, serviceRoleKey);
    await page.goto(`/projects/${projectId}/tables/secrets`);

    // Wait for table to load
    await expect(page.locator("table")).toBeVisible({ timeout: 15_000 });

    // Click the Unlock button to open the decrypt dialog
    await page.getByRole("button", { name: "Unlock" }).click();

    // The warning should be visible
    await expect(page.getByTestId("encryption-key-warning")).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByText("Your encryption key is never sent to the server"),
    ).toBeVisible();
    await expect(
      page.getByText("permanently unrecoverable"),
    ).toBeVisible();

    // Dismiss the warning
    await page.getByRole("button", { name: "Dismiss" }).click();
    await expect(page.getByTestId("encryption-key-warning")).not.toBeVisible();
  });
});
