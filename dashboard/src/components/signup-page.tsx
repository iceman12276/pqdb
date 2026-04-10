import * as React from "react";
import { generateKeyPair, type KeyPair } from "@pqdb/client";
import { api } from "~/lib/api-client";
import { setTokens } from "~/lib/auth-store";
import { useNavigate } from "~/lib/navigation";
import { isValidEmail } from "~/lib/validation";
import { handleMcpRedirect } from "~/lib/mcp-callback";
import { deriveWrappingKey } from "~/lib/envelope-crypto";
import { useEnvelopeKeys } from "~/lib/envelope-key-context";
import { saveKeypair } from "~/lib/keypair-store";
import { RecoveryFileModal } from "~/components/recovery-file-modal";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";

interface PostSignupState {
  developerId: string;
  email: string;
  keypair: KeyPair;
  accessToken: string;
}

/** Base64-encode raw bytes in a JSDOM/browser-safe way. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

/**
 * Decode the `sub` claim (developer id) from a JWT access token without
 * verifying the signature. Safe here because we only need the id to key
 * the IndexedDB record — the token itself has already been issued by the
 * server and will be re-verified on every subsequent request.
 */
function developerIdFromAccessToken(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Malformed access token");
  }
  // Base64url → base64
  const payload = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
  const decoded = atob(padded);
  const claims = JSON.parse(decoded) as { sub?: string };
  if (!claims.sub) {
    throw new Error("Access token missing sub claim");
  }
  return claims.sub;
}

export function SignupPage() {
  const navigate = useNavigate();
  const { setWrappingKey } = useEnvelopeKeys();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [postSignup, setPostSignup] = React.useState<PostSignupState | null>(
    null,
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError("Email is required");
      return;
    }
    if (!isValidEmail(email)) {
      setError("Valid email is required");
      return;
    }
    if (!password) {
      setError("Password is required");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }

    setLoading(true);
    try {
      // Generate the ML-KEM-768 keypair BEFORE the signup call so the
      // server can persist the public key atomically with the account.
      // Running keypair generation + PBKDF2 derivation in parallel with
      // the network request would be nice, but we need the public key
      // before the POST body exists, so sequence it first and then race
      // the PBKDF2 against the network RTT.
      const keypair = await generateKeyPair();
      const publicKeyB64 = bytesToBase64(keypair.publicKey);

      const [result, wrappingKeyResult] = await Promise.all([
        api.signup(email, password, publicKeyB64),
        deriveWrappingKey(password, email).catch((err) => {
          console.warn("[pqdb] Failed to derive wrapping key:", err);
          return null;
        }),
      ]);

      if (result.error) {
        setError(result.error.message);
        return;
      }

      setTokens(
        {
          access_token: result.data.access_token,
          refresh_token: result.data.refresh_token,
        },
        { persist: true },
      );

      if (wrappingKeyResult) {
        setWrappingKey(wrappingKeyResult);
      }

      // Persist the private key to IndexedDB keyed by developer id so it
      // survives reloads. The id must come from the newly issued access
      // token — the server is the only authority on the developer's UUID.
      const developerId = developerIdFromAccessToken(result.data.access_token);
      await saveKeypair(developerId, {
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
      });

      // Show the recovery modal instead of navigating immediately. The
      // user has exactly one chance to save an offline backup of the
      // private key; navigation happens after they dismiss the modal.
      setPostSignup({
        developerId,
        email,
        keypair,
        accessToken: result.data.access_token,
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleRecoveryModalClose() {
    if (!postSignup) return;
    const accessToken = postSignup.accessToken;
    setPostSignup(null);
    if (!(await handleMcpRedirect(accessToken))) {
      navigate({ to: "/projects" });
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Create your account</CardTitle>
          <CardDescription>
            Start building with post-quantum security.
          </CardDescription>
        </CardHeader>

        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                autoComplete="new-password"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "Creating account..." : "Create account"}
            </Button>
          </form>
        </CardContent>

        <CardFooter className="justify-center">
          <p className="text-sm text-muted-foreground">
            Already have an account?{" "}
            <a href="/login" className="text-primary hover:underline">
              Sign in
            </a>
          </p>
        </CardFooter>
      </Card>

      {postSignup && (
        <RecoveryFileModal
          developerId={postSignup.developerId}
          email={postSignup.email}
          keypair={postSignup.keypair}
          onClose={handleRecoveryModalClose}
        />
      )}
    </div>
  );
}
