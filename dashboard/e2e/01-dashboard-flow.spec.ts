/**
 * Test 1 — Dashboard flow
 *
 * Login with email/password -> create project -> view in project list ->
 * navigate to project overview -> see status cards.
 */
import { test, expect } from "@playwright/test";
import { testEmail, signUp, createProject } from "./helpers";

const PASSWORD = "TestPassword123!";

test.describe("Dashboard flow", () => {
  let email: string;

  test.beforeEach(() => {
    email = testEmail();
  });

  test("signup, create project, view overview with status cards", async ({ page }) => {
    // 1. Sign up (creates account and redirects to /projects)
    await signUp(page, email, PASSWORD);

    // 2. Should see the empty-state project list
    await expect(page.getByTestId("empty-state")).toBeVisible();
    await expect(page.getByText("No projects yet")).toBeVisible();

    // 3. Create a project
    const projectName = `e2e-project-${Date.now()}`;
    const projectId = await createProject(page, projectName);

    // 4. Should be on the project overview page
    expect(page.url()).toContain(`/projects/${projectId}`);
    await expect(page.getByTestId("project-overview")).toBeVisible({ timeout: 15_000 });

    // 5. Verify the project name is displayed
    await expect(page.getByText(projectName)).toBeVisible();

    // 6. Verify status cards are rendered
    await expect(page.getByTestId("status-cards")).toBeVisible();
    await expect(page.getByTestId("status-card-status")).toBeVisible();
    await expect(page.getByTestId("status-card-tables")).toBeVisible();
    await expect(page.getByTestId("status-card-encryption")).toBeVisible();

    // 7. Navigate back to projects list and see the project
    await page.goto("/projects");
    await expect(page.getByText(projectName)).toBeVisible({ timeout: 10_000 });
  });

  test("login with existing credentials after signup", async ({ page }) => {
    // Sign up first
    await signUp(page, email, PASSWORD);

    // Clear session (simulate sign-out)
    await page.evaluate(() => sessionStorage.clear());

    // Log in
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();

    // Should redirect to projects
    await expect(page).toHaveURL(/\/projects/, { timeout: 15_000 });
  });
});
