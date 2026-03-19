/**
 * Test 3 — Data viewer + decryption
 *
 * Insert data via SDK -> navigate to table editor -> encrypted columns show
 * [encrypted] -> unlock with encryption key -> plaintext visible ->
 * lock -> reverts to [encrypted].
 *
 * We encrypt data programmatically using the same ML-KEM-768 + AES-256-GCM scheme
 * and insert via the API with raw encrypted column names (_encrypted / _index).
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
const ENCRYPTION_KEY = "e2e-test-encryption-key-2024";

/**
 * Encrypt a value using ML-KEM-768 + AES-256-GCM (same scheme as @pqdb/client).
 * Uses dynamic imports to match the dashboard's approach.
 */
async function encryptValue(plaintext: string, encryptionKey: string): Promise<string> {
  // We need to use the same derivation as the SDK/dashboard
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");
  const { sha3_256 } = await import("@noble/hashes/sha3.js");

  const encoder = new TextEncoder();
  const keyBytes = encoder.encode(encryptionKey);
  const d = sha3_256(new Uint8Array([...keyBytes, 0x01]));
  const z = sha3_256(new Uint8Array([...keyBytes, 0x02]));
  const seed = new Uint8Array(64);
  seed.set(d, 0);
  seed.set(z, 32);
  const { publicKey } = ml_kem768.keygen(seed);

  // Encapsulate
  const { cipherText: kemCiphertext, sharedSecret } = ml_kem768.encapsulate(publicKey);

  // AES-256-GCM encrypt
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(sharedSecret).buffer as ArrayBuffer,
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const plaintextBytes = encoder.encode(plaintext);
  const aesCiphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintextBytes),
  );

  // Concatenate: KEM ciphertext || nonce || AES ciphertext
  const result = new Uint8Array(kemCiphertext.byteLength + nonce.byteLength + aesCiphertext.byteLength);
  result.set(kemCiphertext, 0);
  result.set(nonce, kemCiphertext.byteLength);
  result.set(aesCiphertext, kemCiphertext.byteLength + nonce.byteLength);

  // Base64 encode
  let binary = "";
  for (const byte of result) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

test.describe("Data viewer + decryption", () => {
  let accessToken: string;
  let refreshToken: string;
  let projectId: string;
  let serviceRoleKey: string;

  test.beforeAll(async () => {
    const email = testEmail();
    const tokens = await apiSignup(BASE_URL, email, PASSWORD);
    accessToken = tokens.access_token;
    refreshToken = tokens.refresh_token;

    const project = await apiCreateProject(BASE_URL, accessToken, `decrypt-e2e-${Date.now()}`);
    projectId = project.id;
    serviceRoleKey = project.api_keys.find((k) => k.role === "service")!.key;

    // Create table with mixed columns
    await apiCreateTable(BASE_URL, serviceRoleKey, "contacts", [
      { name: "contact_id", data_type: "uuid", sensitivity: "plain", owner: true },
      { name: "name", data_type: "text", sensitivity: "plain" },
      { name: "email", data_type: "text", sensitivity: "searchable" },
      { name: "phone", data_type: "text", sensitivity: "private" },
    ]);

    // Insert a row with encrypted values via raw column names
    const encryptedEmail = await encryptValue("alice@example.com", ENCRYPTION_KEY);
    const encryptedPhone = await encryptValue("+1-555-0100", ENCRYPTION_KEY);

    const resp = await fetch(`${BASE_URL}/v1/db/contacts/insert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({
        rows: [
          {
            name: "Alice",
            email: encryptedEmail,
            email_index: "dummy-blind-index-value",
            phone: encryptedPhone,
          },
        ],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Insert encrypted row failed (${resp.status}): ${body}`);
    }
  });

  test("encrypted columns show [encrypted], unlock shows plaintext, lock reverts", async ({ page }) => {
    // Navigate to the table editor
    await page.goto("/login", { waitUntil: "networkidle" });
    await injectTokens(page, accessToken, refreshToken);
    await mockProjectKeys(page, projectId, serviceRoleKey);
    await page.goto(`/projects/${projectId}/tables/contacts`);

    // Wait for table data to load
    await expect(page.locator("table")).toBeVisible({ timeout: 15_000 });

    // 1. Verify plain column shows data
    await expect(page.getByText("Alice")).toBeVisible();

    // 2. Verify encrypted columns show [encrypted]
    const encryptedCells = page.getByText("[encrypted]");
    await expect(encryptedCells.first()).toBeVisible();

    // 3. Click Unlock button
    await page.getByRole("button", { name: "Unlock" }).click();

    // 4. Enter the encryption key in the dialog
    await expect(page.getByLabel("Encryption Key")).toBeVisible({ timeout: 5_000 });
    await page.getByLabel("Encryption Key").fill(ENCRYPTION_KEY);
    await page.getByRole("button", { name: "Decrypt" }).click();

    // 5. Wait for decryption — plaintext should appear
    await expect(page.getByText("alice@example.com")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("+1-555-0100")).toBeVisible();

    // 6. [encrypted] should no longer be visible
    await expect(page.getByText("[encrypted]")).not.toBeVisible();

    // 7. Click Lock button to re-encrypt
    await page.getByRole("button", { name: "Lock" }).click();

    // 8. Encrypted columns should show [encrypted] again
    await expect(page.getByText("[encrypted]").first()).toBeVisible({ timeout: 5_000 });

    // 9. Plaintext should no longer be visible
    await expect(page.getByText("alice@example.com")).not.toBeVisible();
  });
});
