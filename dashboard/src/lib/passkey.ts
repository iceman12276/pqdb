/**
 * Passkey/WebAuthn client utilities.
 * Wraps navigator.credentials calls and communicates with backend passkey endpoints.
 */

import type { TokenPair } from "./auth-store";

interface ChallengeResponse {
  challenge: string;
  [key: string]: unknown;
}

function base64urlToBuffer(base64url: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/") + padding;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function bufferToBase64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Start passkey authentication (login).
 * Uses discoverable credentials (no allowCredentials).
 */
export async function startPasskeyAuthentication(): Promise<TokenPair> {
  // 1. Get authentication challenge from backend
  const challengeResp = await fetch(
    "/v1/auth/passkeys/challenge?purpose=authentication",
  );
  if (!challengeResp.ok) {
    throw new Error("Failed to get authentication challenge");
  }
  const options: ChallengeResponse = await challengeResp.json();

  // 2. Call navigator.credentials.get()
  const publicKeyOptions: PublicKeyCredentialRequestOptions = {
    challenge: base64urlToBuffer(options.challenge as string),
    rpId: options.rpId as string,
    timeout: (options.timeout as number) ?? 60000,
    userVerification:
      (options.userVerification as UserVerificationRequirement) ?? "preferred",
    allowCredentials: [],
  };

  const credential = (await navigator.credentials.get({
    publicKey: publicKeyOptions,
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Passkey authentication was cancelled");
  }

  const response = credential.response as AuthenticatorAssertionResponse;

  // 3. Send assertion to backend
  const body = {
    credential: {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(response.clientDataJSON),
        authenticatorData: bufferToBase64url(response.authenticatorData),
        signature: bufferToBase64url(response.signature),
        userHandle: response.userHandle
          ? bufferToBase64url(response.userHandle)
          : null,
      },
    },
  };

  const authResp = await fetch("/v1/auth/passkeys/authenticate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!authResp.ok) {
    const data = await authResp.json().catch(() => null);
    const message =
      (data as { detail?: string } | null)?.detail ??
      "Passkey authentication failed";
    throw new Error(message);
  }

  const tokens: TokenPair & { token_type: string } = await authResp.json();
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
  };
}

/**
 * Start passkey registration (from settings page).
 * Requires an access token for the authenticated developer.
 */
export async function startPasskeyRegistration(
  accessToken: string,
  developerId: string,
  name?: string,
): Promise<{ id: string; name: string | null }> {
  // 1. Get registration challenge
  const challengeResp = await fetch(
    `/v1/auth/passkeys/challenge?purpose=registration&developer_id=${developerId}`,
  );
  if (!challengeResp.ok) {
    throw new Error("Failed to get registration challenge");
  }
  const options: ChallengeResponse = await challengeResp.json();

  // 2. Call navigator.credentials.create()
  const rp = options.rp as { id: string; name: string };
  const user = options.user as {
    id: string;
    name: string;
    displayName: string;
  };
  const pubKeyCredParams = options.pubKeyCredParams as {
    type: string;
    alg: number;
  }[];
  const excludeCredentials = (
    options.excludeCredentials as { id: string; type: string }[] | undefined
  )?.map((c) => ({
    id: base64urlToBuffer(c.id),
    type: c.type as PublicKeyCredentialType,
  }));

  const createOptions: PublicKeyCredentialCreationOptions = {
    challenge: base64urlToBuffer(options.challenge as string),
    rp: { id: rp.id, name: rp.name },
    user: {
      id: base64urlToBuffer(user.id),
      name: user.name,
      displayName: user.displayName,
    },
    pubKeyCredParams: pubKeyCredParams.map((p) => ({
      type: p.type as PublicKeyCredentialType,
      alg: p.alg,
    })),
    timeout: (options.timeout as number) ?? 60000,
    excludeCredentials,
    authenticatorSelection: options.authenticatorSelection as
      | AuthenticatorSelectionCriteria
      | undefined,
  };

  const credential = (await navigator.credentials.create({
    publicKey: createOptions,
  })) as PublicKeyCredential | null;

  if (!credential) {
    throw new Error("Passkey registration was cancelled");
  }

  const response = credential.response as AuthenticatorAttestationResponse;

  // 3. Send attestation to backend
  const body = {
    credential: {
      id: credential.id,
      rawId: bufferToBase64url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bufferToBase64url(response.clientDataJSON),
        attestationObject: bufferToBase64url(response.attestationObject),
      },
    },
    name: name ?? null,
  };

  const regResp = await fetch("/v1/auth/passkeys/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  if (!regResp.ok) {
    const data = await regResp.json().catch(() => null);
    const message =
      (data as { detail?: string } | null)?.detail ??
      "Passkey registration failed";
    throw new Error(message);
  }

  return regResp.json();
}
