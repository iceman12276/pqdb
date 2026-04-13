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
 * Inject auth tokens AND a dummy keypair into the browser context so the
 * app treats us as fully authenticated. Useful when we need to bypass the
 * UI login flow (e.g. after API signup).
 *
 * Writes the tokens to `sessionStorage` (matching `auth-store.ts`) AND
 * writes a dummy ML-KEM-768 keypair to IndexedDB (matching
 * `keypair-store.ts`) so `useKeypair()` resolves to `loaded: true` instead
 * of `error: "missing"`. Without the keypair injection, the
 * `RecoverKeypairModal` rendered by `KeypairRecovery` in `__root.tsx`
 * intercepts all pointer events with its z-50 overlay and turns every
 * subsequent click into a 60-second timeout.
 *
 * The dummy keypair bytes are NOT real ML-KEM keys — they're correctly-
 * sized random fillers. That's fine for UI tests that exercise schema,
 * navigation, or other non-crypto flows. Tests that actually decrypt
 * encrypted rows MUST use {@link apiSignupWithKeypair} (not yet
 * implemented) to get a real keypair whose public half was uploaded
 * during signup.
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
  await injectDummyKeypair(page, accessToken);
}

/**
 * Decode a JWT's payload without verifying. E2E-only helper — we need the
 * `sub` claim (developer UUID) to key IndexedDB records. Playwright's
 * Node-side code can't use the `jsonwebtoken` library without pulling in
 * the backend test fixtures, so we inline a minimal base64url decode.
 */
function decodeJwtSub(jwt: string): string {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error(`invalid JWT: ${jwt.slice(0, 20)}…`);
  const payload = Buffer.from(
    parts[1].replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  ).toString("utf-8");
  const obj = JSON.parse(payload) as { sub?: string };
  if (!obj.sub) throw new Error("JWT missing sub claim");
  return obj.sub;
}

/**
 * Pre-populate IndexedDB with a dummy ML-KEM-768 keypair for the developer
 * so `useKeypair()` returns `loaded: true` instead of `error: "missing"`,
 * preventing the `RecoverKeypairModal` from intercepting pointer events
 * and blocking test interactions.
 *
 * The dummy bytes are valid-sized Uint8Arrays (1184 bytes public, 2400
 * bytes secret, per FIPS 203) but are NOT real ML-KEM keys — they're
 * random fillers. That's fine for tests that exercise schema / UI flows
 * without actually decrypting data. Tests that need to decrypt encrypted
 * content MUST inject real keys generated via `@pqdb/client.generateKeyPair`
 * and the matching `ml_kem_public_key` uploaded during signup.
 *
 * Without this helper, any test that uses `apiSignup` will hit the
 * recover-keypair modal as soon as it navigates to an authenticated
 * route, because `apiSignup` skips the UI signup flow (which is where
 * real keypair generation + upload happens).
 */
export async function injectDummyKeypair(
  page: Page,
  accessToken: string,
): Promise<void> {
  const developerId = decodeJwtSub(accessToken);
  // Generate random bytes at the correct ML-KEM-768 sizes. Shape validation
  // in keypair-store.ts only checks that both fields are Uint8Array; it
  // doesn't run a KAT, so random bytes pass the gate.
  const publicKey = Array.from({ length: 1184 }, (_, i) => i % 256);
  const secretKey = Array.from({ length: 2400 }, (_, i) => (i + 1) % 256);

  await page.evaluate(
    async ({ developerId, publicKey, secretKey }) => {
      const DB_NAME = "pqdb";
      const STORE_NAME = "keypairs";
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "developerId" });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(STORE_NAME, "readwrite");
          const store = tx.objectStore(STORE_NAME);
          store.put({
            developerId,
            publicKey: new Uint8Array(publicKey),
            secretKey: new Uint8Array(secretKey),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
        req.onerror = () => reject(req.error);
      });
    },
    { developerId, publicKey, secretKey },
  );
}

/**
 * Intercept the endpoints that feed `project-context.tsx` so the dashboard
 * uses the pre-created service role key from the test's `beforeAll` instead
 * of asking the backend to mint a new one at render time.
 *
 * Two endpoints are mocked because the dashboard calls BOTH:
 *
 * 1. `GET /v1/projects/{projectId}/keys` — the list-keys endpoint, used by
 *    some routes for displaying key metadata. The real endpoint only returns
 *    a truncated `key_prefix` which would break backend auth in tests, so
 *    we return the full key as `key_prefix`.
 *
 * 2. `POST /v1/projects/{projectId}/keys/service-key` — the create-on-demand
 *    endpoint that `ProjectProvider.load()` hits via `fetchServiceKey()`
 *    when the dashboard needs an apikey to pass to /v1/db/* calls. Without
 *    this mock the test depends on the real backend creating a new key
 *    every time, which silently fails under auth edge cases and leaves
 *    `apiKey === null`, which makes `SchemaRouteInner` render "No API key
 *    found" instead of `<SchemaPage>`. That's the root cause of the
 *    deterministic ~30s click-timeout flake on this file's ERD and
 *    Physical-view tests.
 *
 * The dashboard expects role "service_role" (the backend returns "service"),
 * hence the explicit role normalization.
 */
export async function mockProjectKeys(
  page: Page,
  projectId: string,
  serviceKey: string,
  anonKey?: string,
): Promise<void> {
  const listKeysResponse = [
    {
      id: "mock-service-key-id",
      role: "service_role",
      key_prefix: serviceKey,
      created_at: new Date().toISOString(),
    },
  ];
  if (anonKey) {
    listKeysResponse.push({
      id: "mock-anon-key-id",
      role: "anon",
      key_prefix: anonKey,
      created_at: new Date().toISOString(),
    });
  }

  // 1. List keys (GET)
  await page.route(`**/v1/projects/${projectId}/keys`, async (route) => {
    if (route.request().method() !== "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(listKeysResponse),
    });
  });

  // 2. Create service key on demand (POST) — this is what `ProjectProvider`
  //    actually hits via `fetchServiceKey()`. Shape matches ApiKeyCreated:
  //    the `key` field is the full plaintext key.
  const serviceKeyResponse = {
    id: "mock-service-key-id",
    role: "service_role",
    key: serviceKey,
    key_prefix: serviceKey,
    created_at: new Date().toISOString(),
  };
  await page.route(
    `**/v1/projects/${projectId}/keys/service-key`,
    async (route) => {
      if (route.request().method() !== "POST") {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(serviceKeyResponse),
      });
    },
  );

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
