/**
 * Test 5 — Passkey
 *
 * Register passkey (WebAuthn mock via Playwright virtual authenticator) ->
 * sign out -> sign in with passkey -> Dashboard access.
 *
 * Uses Playwright's CDP session to add a virtual authenticator that
 * automatically responds to WebAuthn requests.
 */
import { test, expect, type Page, type CDPSession } from "@playwright/test";
import { testEmail, apiSignup, injectTokens } from "./helpers";

const PASSWORD = "TestPassword123!";
const BASE_URL = "http://localhost:8000";

async function addVirtualAuthenticator(page: Page): Promise<{
  cdp: CDPSession;
  authenticatorId: string;
}> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });
  return { cdp, authenticatorId };
}

test.describe("Passkey authentication", () => {
  test("register passkey from settings, sign out, sign in with passkey", async ({
    page,
  }) => {
    // 1. Create developer account
    const email = testEmail();
    const tokens = await apiSignup(BASE_URL, email, PASSWORD);

    // 2. Add virtual authenticator via CDP (must be on same page)
    const { cdp, authenticatorId } = await addVirtualAuthenticator(page);

    try {
      // 3. Navigate to settings page (authenticated)
      await page.goto("/login", { waitUntil: "networkidle" });
      await injectTokens(page, tokens.access_token, tokens.refresh_token);
      await page.goto("/settings", { waitUntil: "networkidle" });

      // Wait for settings page to load
      await expect(page.getByText("Security")).toBeVisible({ timeout: 15_000 });

      // Should show "No passkeys registered"
      await expect(page.getByTestId("no-passkeys")).toBeVisible();

      // 4. Register a passkey
      await page.getByPlaceholder("Passkey name (optional)").fill("E2E Test Key");
      await page.getByRole("button", { name: "Add Passkey" }).click();

      // Wait for registration to complete — the passkey list should appear
      await expect(page.getByTestId("passkey-list")).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText("E2E Test Key")).toBeVisible();

      // 5. Sign out by clearing tokens
      await page.evaluate(() => {
        sessionStorage.clear();
      });

      // 6. Navigate to login and sign in with passkey
      await page.goto("/login", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Sign in with Passkey" }).click();

      // Virtual authenticator handles the WebAuthn ceremony automatically
      // Should redirect to /projects on success
      await expect(page).toHaveURL(/\/projects/, { timeout: 15_000 });

      // 7. Verify Dashboard access
      await expect(
        page.getByText("No projects yet").or(page.getByText("Projects")),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      // Cleanup
      await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      await cdp.send("WebAuthn.disable");
      await cdp.detach();
    }
  });
});
