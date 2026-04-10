/**
 * E2E: signup happy path generates an ML-KEM-768 keypair, offers a
 * downloadable recovery file with both keys, and lands on /projects.
 *
 * What this verifies end-to-end:
 *  - /signup page generates a keypair client-side
 *  - The post-signup recovery modal appears and is blocking
 *  - Clicking "Download recovery file" produces a JSON blob whose
 *    `public_key` and `private_key` fields round-trip from base64
 *  - The backend persisted the uploaded public key (GET /v1/auth/me/public-key)
 *    so we know the public key in the file matches what the server stored
 *  - Navigation completes to /projects after the modal is closed
 */
import { test, expect } from "@playwright/test";
import { testEmail } from "./helpers";

interface RecoveryFile {
  version: number;
  developer_id: string;
  email: string;
  public_key: string;
  private_key: string;
  created_at: string;
  warning: string;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

test("signup downloads a parseable recovery file with both ML-KEM keys", async ({
  page,
}) => {
  const email = testEmail();
  const password = "password123";

  await page.goto("/signup", { waitUntil: "networkidle" });

  // Fill the form
  const emailInput = page.locator("#email");
  await emailInput.waitFor({ state: "visible", timeout: 10_000 });
  await emailInput.fill(email);
  await page.locator("#password").fill(password);
  await expect(emailInput).toHaveValue(email);

  // Capture the signup POST so we can assert the public key was sent
  const signupReq = page.waitForRequest(
    (req) => req.url().endsWith("/v1/auth/signup") && req.method() === "POST",
  );
  const signupResp = page.waitForResponse(
    (resp) =>
      resp.url().endsWith("/v1/auth/signup") && resp.status() === 201,
  );

  await page.getByRole("button", { name: "Create account" }).click();

  const req = await signupReq;
  const postBody = req.postDataJSON() as {
    email: string;
    password: string;
    ml_kem_public_key?: string;
  };
  expect(postBody.email).toBe(email);
  expect(typeof postBody.ml_kem_public_key).toBe("string");
  expect(base64ToBytes(postBody.ml_kem_public_key!).length).toBe(1184);

  await signupResp;

  // Recovery modal must be visible and blocking navigation
  const modal = page.getByRole("dialog", { name: /save your recovery file/i });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/projects/);

  // Trigger the download and parse the JSON
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: /download recovery file/i }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toBe(`pqdb-recovery-${email}.json`);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8");
  const parsed = JSON.parse(raw) as RecoveryFile;

  expect(parsed.version).toBe(1);
  expect(parsed.email).toBe(email);
  expect(typeof parsed.developer_id).toBe("string");
  expect(parsed.warning).toMatch(/decrypt/i);

  const pub = base64ToBytes(parsed.public_key);
  const priv = base64ToBytes(parsed.private_key);
  expect(pub.length).toBe(1184);
  // ML-KEM-768 secret key length per FIPS 203 is 2400 bytes.
  expect(priv.length).toBe(2400);

  // The public key in the recovery file MUST match what the backend
  // stored — otherwise a future device-restore would fail.
  const tokens = await page.evaluate(() =>
    sessionStorage.getItem("pqdb-tokens"),
  );
  expect(tokens).not.toBeNull();
  const { access_token } = JSON.parse(tokens!) as {
    access_token: string;
    refresh_token: string;
  };
  const meResp = await page.request.get("/v1/auth/me/public-key", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  expect(meResp.ok()).toBe(true);
  const meBody = (await meResp.json()) as { public_key: string | null };
  expect(meBody.public_key).toBe(parsed.public_key);

  // Close the modal — download alone is enough to unlock the close button
  await page.getByRole("button", { name: /^close$/i }).click();
  await expect(page).toHaveURL(/\/projects/, { timeout: 15_000 });
});
