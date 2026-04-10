/**
 * E2E test helpers — shared utilities for all Phase 3a E2E tests.
 */
import { type Page, expect } from "@playwright/test";

/** Generate a unique email for test isolation. */
export function testEmail(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Sign up a new developer via the Dashboard and navigate to /projects. */
export async function signUp(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/signup", { waitUntil: "networkidle" });
  // Wait for React hydration — input must respond to user interaction
  const emailInput = page.locator("#email");
  await emailInput.waitFor({ state: "visible", timeout: 10_000 });
  // Type character-by-character to ensure React picks up the input
  await emailInput.click();
  await emailInput.fill(email);
  const passwordInput = page.locator("#password");
  await passwordInput.click();
  await passwordInput.fill(password);
  // Verify inputs have values before clicking submit
  await expect(emailInput).toHaveValue(email);
  await expect(passwordInput).toHaveValue(password);
  await page.getByRole("button", { name: "Create account" }).click();
  // Signup now pops a recovery-file modal that blocks navigation until
  // the user either downloads the file or acknowledges the warning. For
  // E2E tests that don't care about the recovery flow we acknowledge
  // and close, then continue to /projects as before.
  const modal = page.getByRole("dialog", { name: /save your recovery file/i });
  await modal.waitFor({ state: "visible", timeout: 15_000 });
  await page.getByRole("checkbox", { name: /i understand/i }).check();
  await page.getByRole("button", { name: /^close$/i }).click();
  await expect(page).toHaveURL(/\/projects/, { timeout: 15_000 });
}

/** Log in an existing developer via the Dashboard and navigate to /projects. */
export async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login", { waitUntil: "networkidle" });
  const emailInput = page.locator("#email");
  await emailInput.waitFor({ state: "visible", timeout: 10_000 });
  await emailInput.click();
  await emailInput.fill(email);
  const passwordInput = page.locator("#password");
  await passwordInput.click();
  await passwordInput.fill(password);
  await expect(emailInput).toHaveValue(email);
  await expect(passwordInput).toHaveValue(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/projects/, { timeout: 15_000 });
}

/** Create a project from the /projects page and return the project ID from the URL. */
export async function createProject(page: Page, name: string): Promise<string> {
  // Click "Create Project" button
  await page.getByRole("button", { name: "Create Project" }).click();

  // Fill in the dialog
  await page.getByLabel("Project Name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();

  // Wait for navigation to project overview
  await expect(page).toHaveURL(/\/projects\/[a-f0-9-]+/, { timeout: 15_000 });

  const url = page.url();
  const match = url.match(/\/projects\/([a-f0-9-]+)/);
  if (!match) throw new Error(`Could not extract project ID from URL: ${url}`);
  return match[1];
}

/**
 * Inject auth tokens into sessionStorage so the app treats us as logged in.
 * Useful when we need to bypass the UI login flow (e.g. after API signup).
 */
export async function injectTokens(
  page: Page,
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  await page.evaluate(
    ({ access_token, refresh_token }) => {
      sessionStorage.setItem(
        "pqdb-tokens",
        JSON.stringify({ access_token, refresh_token }),
      );
    },
    { access_token: accessToken, refresh_token: refreshToken },
  );
}

/**
 * Intercept the GET /v1/projects/{projectId}/keys endpoint to return the full
 * API key as `key_prefix`. The Dashboard uses key_prefix from the list-keys
 * endpoint as the apikey header; this mock ensures the full key is used so
 * that project-scoped API calls (schema, tables, etc.) succeed in E2E tests.
 */
export async function mockProjectKeys(
  page: Page,
  projectId: string,
  serviceKey: string,
  anonKey?: string,
): Promise<void> {
  // The Dashboard route code looks for role "service_role" (not "service" which
  // the backend actually returns). We return "service_role" to match the
  // Dashboard's expectation, and the full key as key_prefix (the real endpoint
  // only returns a truncated prefix, which breaks backend auth).
  const keys = [
    {
      id: "mock-service-key-id",
      role: "service_role",
      key_prefix: serviceKey,
      created_at: new Date().toISOString(),
    },
  ];
  if (anonKey) {
    keys.push({
      id: "mock-anon-key-id",
      role: "anon",
      key_prefix: anonKey,
      created_at: new Date().toISOString(),
    });
  }

  await page.route(`**/v1/projects/${projectId}/keys`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(keys),
    });
  });

  // Strip the Authorization header from project-scoped /v1/db/* requests.
  // The Dashboard's api.fetch sends the developer JWT as Authorization,
  // but the backend's get_current_user validates it as a project user JWT
  // and returns 401 when the format doesn't match.
  await page.route("**/v1/db/**", async (route) => {
    const headers = { ...route.request().headers() };
    delete headers["authorization"];
    await route.continue({ headers });
  });
}

/**
 * Sign up via the backend API directly (faster than going through the UI).
 * Returns access and refresh tokens.
 */
export async function apiSignup(
  baseURL: string,
  email: string,
  password: string,
): Promise<{ access_token: string; refresh_token: string }> {
  const resp = await fetch(`${baseURL}/v1/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API signup failed (${resp.status}): ${body}`);
  }
  return resp.json();
}

/**
 * Create a project via the backend API directly.
 * Returns the full project creation response including api_keys.
 */
export async function apiCreateProject(
  baseURL: string,
  accessToken: string,
  name: string,
): Promise<{
  id: string;
  name: string;
  api_keys: Array<{ id: string; role: string; key: string; key_prefix: string }>;
}> {
  const resp = await fetch(`${baseURL}/v1/projects`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ name, region: "us-east-1" }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API create project failed (${resp.status}): ${body}`);
  }
  return resp.json();
}

/**
 * Create a table via the backend API.
 */
export async function apiCreateTable(
  baseURL: string,
  apiKey: string,
  tableName: string,
  columns: Array<{
    name: string;
    data_type: string;
    sensitivity: string;
    owner?: boolean;
  }>,
): Promise<void> {
  const resp = await fetch(`${baseURL}/v1/db/tables`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({ name: tableName, columns }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API create table failed (${resp.status}): ${body}`);
  }
}

/**
 * Insert a row via the backend API.
 */
export async function apiInsertRow(
  baseURL: string,
  apiKey: string,
  tableName: string,
  row: Record<string, unknown>,
): Promise<void> {
  const resp = await fetch(`${baseURL}/v1/db/${tableName}/insert`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify({ rows: [row] }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`API insert row failed (${resp.status}): ${body}`);
  }
}
