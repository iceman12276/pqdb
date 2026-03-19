/**
 * E2E test helpers — shared utilities for all Phase 3a E2E tests.
 */
import { type Page, expect } from "@playwright/test";

/** Generate a unique email for test isolation. */
export function testEmail(): string {
  return `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@test.local`;
}

/** Sign up a new developer via the Dashboard and navigate to /projects. */
export async function signUp(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  // Wait for redirect to /projects
  await expect(page).toHaveURL(/\/projects/, { timeout: 15_000 });
}

/** Log in an existing developer via the Dashboard and navigate to /projects. */
export async function logIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
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
