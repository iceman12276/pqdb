/**
 * Test 1 — Dashboard flow
 *
 * Login with email/password -> create project -> view in project list ->
 * navigate to project overview -> see status cards.
 */
import { test, expect } from "@playwright/test";
import { testEmail, signUp, logIn, createProject } from "./helpers";

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

    // 5. Verify the project name is displayed. The project name now
    // appears in TWO elements on this page: the breadcrumb
    // (`data-testid="breadcrumb-project-name"`) and the h1 heading.
    // Using a bare `getByText(projectName)` throws a strict-mode
    // violation ("resolved to 2 elements") whenever both mount by
    // assertion time, which is a deterministic race on CI. Target
    // the h1 specifically — it's the canonical "project name on
    // the overview page" element.
    await expect(
      page.getByRole("heading", { level: 1, name: projectName }),
    ).toBeVisible();

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

    // Log in using the helper (handles hydration wait)
    await logIn(page, email, PASSWORD);
  });
});
