/**
 * Test 2 — Schema visualizer
 *
 * Create tables with mixed sensitivity -> navigate to schema page ->
 * ERD renders with correct sensitivity badges and relationships.
 */
import { test, expect } from "@playwright/test";
import {
  testEmail,
  apiSignup,
  apiCreateProject,
  apiCreateTable,
  injectTokens,
} from "./helpers";

const PASSWORD = "TestPassword123!";
const BASE_URL = "http://localhost:8000";

test.describe("Schema visualizer", () => {
  let accessToken: string;
  let projectId: string;
  let serviceRoleKey: string;

  test.beforeAll(async () => {
    const email = testEmail();

    // Create developer + project via API for speed
    const tokens = await apiSignup(BASE_URL, email, PASSWORD);
    accessToken = tokens.access_token;

    const project = await apiCreateProject(BASE_URL, accessToken, `schema-e2e-${Date.now()}`);
    projectId = project.id;
    serviceRoleKey = project.api_keys.find((k) => k.role === "service_role")!.key;

    // Create a table with mixed sensitivity columns
    await apiCreateTable(BASE_URL, serviceRoleKey, "users", [
      { name: "id", data_type: "uuid", sensitivity: "plain", owner: true },
      { name: "username", data_type: "text", sensitivity: "plain" },
      { name: "email", data_type: "text", sensitivity: "searchable" },
      { name: "ssn", data_type: "text", sensitivity: "private" },
    ]);

    // Create a second table for relationship testing
    await apiCreateTable(BASE_URL, serviceRoleKey, "posts", [
      { name: "id", data_type: "uuid", sensitivity: "plain", owner: true },
      { name: "title", data_type: "text", sensitivity: "plain" },
      { name: "body", data_type: "text", sensitivity: "private" },
      { name: "user_id", data_type: "uuid", sensitivity: "plain" },
    ]);
  });

  test("displays tables with sensitivity badges in list view", async ({ page }) => {
    // Inject auth tokens and navigate
    await page.goto("/login");
    await injectTokens(page, accessToken, accessToken);
    await page.goto(`/projects/${projectId}/schema`);

    // Wait for schema to load
    await expect(page.getByText("Schema")).toBeVisible({ timeout: 15_000 });

    // Should show both tables
    await expect(page.getByText("users")).toBeVisible();
    await expect(page.getByText("posts")).toBeVisible();

    // Check sensitivity badges exist
    await expect(page.getByTestId("badge-plain").first()).toBeVisible();
    await expect(page.getByTestId("badge-searchable").first()).toBeVisible();
    await expect(page.getByTestId("badge-private").first()).toBeVisible();
  });

  test("ERD tab renders the flow diagram", async ({ page }) => {
    await page.goto("/login");
    await injectTokens(page, accessToken, accessToken);
    await page.goto(`/projects/${projectId}/schema`);

    await expect(page.getByText("Schema")).toBeVisible({ timeout: 15_000 });

    // Switch to ERD tab
    await page.getByRole("tab", { name: "ERD" }).click();

    // The ERD view should render
    await expect(page.getByTestId("erd-view")).toBeVisible({ timeout: 10_000 });

    // ReactFlow should render nodes for both tables
    await expect(page.locator(".react-flow__node").first()).toBeVisible({ timeout: 10_000 });
  });

  test("logical vs physical view toggle works", async ({ page }) => {
    await page.goto("/login");
    await injectTokens(page, accessToken, accessToken);
    await page.goto(`/projects/${projectId}/schema`);

    await expect(page.getByText("Schema")).toBeVisible({ timeout: 15_000 });

    // Default is logical view — should show "email" column
    await expect(page.getByText("email").first()).toBeVisible();

    // Switch to physical view
    await page.getByRole("button", { name: "Physical" }).click();

    // Should show shadow columns: email_encrypted, email_index
    await expect(page.getByText("email_encrypted").first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("email_index").first()).toBeVisible();
  });
});
