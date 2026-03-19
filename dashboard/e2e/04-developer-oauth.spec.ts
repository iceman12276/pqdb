/**
 * Test 4 — Developer OAuth
 *
 * Configure Google OAuth (mock) -> click "Sign in with Google" ->
 * simulate callback -> developer account linked -> Dashboard access.
 *
 * Strategy: Intercept the OAuth authorize redirect to capture the state JWT,
 * then directly navigate to the callback URL with a mock code + state.
 * The backend needs real Vault OAuth credentials, so we mock at the browser
 * level by intercepting the redirect and simulating the callback flow.
 *
 * Since the backend OAuth flow requires Vault-stored credentials and an
 * actual provider exchange, we test the frontend OAuth flow by:
 * 1. Verifying the "Sign in with Google" button triggers the correct redirect
 * 2. Simulating a successful OAuth callback by injecting tokens via URL hash
 */
import { test, expect } from "@playwright/test";
import { testEmail, apiSignup } from "./helpers";

const PASSWORD = "TestPassword123!";
const BASE_URL = "http://localhost:8000";

test.describe("Developer OAuth", () => {
  test("Sign in with Google button redirects to OAuth authorize endpoint", async ({ page }) => {
    // Intercept navigation to the OAuth endpoint
    let oauthUrl: string | null = null;

    await page.route("**/v1/auth/oauth/google/authorize*", async (route) => {
      oauthUrl = route.request().url();
      // Return a mock response instead of following the redirect
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "OAuth provider 'google' is not configured",
        }),
      });
    });

    await page.goto("/login");

    // Click "Sign in with Google"
    await page.getByRole("button", { name: "Sign in with Google" }).click();

    // Wait for the request to be made
    await page.waitForTimeout(1000);

    // The OAuth URL should have been captured
    expect(oauthUrl).toBeTruthy();
    expect(oauthUrl).toContain("/v1/auth/oauth/google/authorize");
    expect(oauthUrl).toContain("redirect_uri=");
  });

  test("OAuth callback with tokens in URL hash grants Dashboard access", async ({ page }) => {
    // Create a real developer account first
    const email = testEmail();
    const tokens = await apiSignup(BASE_URL, email, PASSWORD);

    // Simulate the OAuth callback by navigating to /login with tokens in hash
    // This is exactly what the backend does after a successful OAuth exchange
    const hash = new URLSearchParams({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_type: "bearer",
    }).toString();

    await page.goto(`/login#${hash}`);

    // The LoginPage useEffect should detect the tokens and redirect to /projects
    await expect(page).toHaveURL(/\/projects/, { timeout: 15_000 });

    // Verify we have Dashboard access — should see the project list
    await expect(
      page.getByText("No projects yet").or(page.getByText("Projects")),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Sign in with GitHub button redirects to OAuth authorize endpoint", async ({ page }) => {
    let githubOauthUrl: string | null = null;

    await page.route("**/v1/auth/oauth/github/authorize*", async (route) => {
      githubOauthUrl = route.request().url();
      await route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          detail: "OAuth provider 'github' is not configured",
        }),
      });
    });

    await page.goto("/login");
    await page.getByRole("button", { name: "Sign in with GitHub" }).click();
    await page.waitForTimeout(1000);

    expect(githubOauthUrl).toBeTruthy();
    expect(githubOauthUrl).toContain("/v1/auth/oauth/github/authorize");
    expect(githubOauthUrl).toContain("redirect_uri=");
  });
});
