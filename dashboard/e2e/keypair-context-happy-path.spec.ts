/**
 * E2E: keypair context happy path.
 *
 * Verifies that after signup (which stores the ML-KEM-768 keypair in IDB),
 * the keypair context loads the keys from IndexedDB and:
 *  - The missing-key banner is NOT shown
 *  - Create Project succeeds (proves keypair context provides keys)
 */
import { test, expect } from "@playwright/test";
import { signUp, testEmail } from "./helpers";

test("signup stores keypair in IDB, banner hidden, Create Project works", async ({
  page,
}) => {
  const email = testEmail();
  const password = "password123";

  // Sign up — this generates a keypair, stores it in IDB, and lands on /projects
  await signUp(page, email, password);
  await expect(page).toHaveURL(/\/projects/);

  // The missing-key banner should NOT be shown — keypair loaded from IDB
  const banner = page.locator("[role='status']").filter({
    hasText: /encryption key not loaded/i,
  });
  await expect(banner).toHaveCount(0);

  // Create a project to prove the keypair context is providing keys
  await page.getByRole("button", { name: "Create Project" }).click();
  await page.getByLabel("Project Name").fill(`e2e-keypair-${Date.now()}`);
  await page.getByRole("button", { name: "Create" }).click();

  // Navigation to the project overview proves project creation succeeded
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });
});
