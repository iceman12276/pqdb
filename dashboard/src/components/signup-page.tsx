import * as React from "react";
import { generateKeyPair, type KeyPair } from "@pqdb/client";
import { api } from "~/lib/api-client";
import { setTokens, clearTokens } from "~/lib/auth-store";
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
    // Track whether we already committed auth tokens so the catch block
    // can roll them back if a later step throws. Belt-and-suspenders:
    // the reordered flow already persists the keypair BEFORE setTokens,
    // so this rollback only fires if an unforeseen throw happens after
    // we've committed auth (e.g. setWrappingKey or setPostSignup).
    let tokensSet = false;
    try {
      // 1. Generate the ML-KEM-768 keypair (pure crypto, no side effects).
      //    Must happen before the signup call so the server can persist
      //    the public key atomically with the account.
      const keypair = await generateKeyPair();
      const publicKeyB64 = bytesToBase64(keypair.publicKey);

      // 2. POST /v1/auth/signup with the public key. Derive the wrapping
      //    key in parallel to race PBKDF2 against the network RTT.
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

      // 3. Parse the developer id from the access token (pure function,
      //    no side effects). If the token is malformed this throws and
      //    we abort BEFORE authenticating the user.
      const developerId = developerIdFromAccessToken(result.data.access_token);

      // 4. Persist the private key to IndexedDB FIRST — this is the
      //    critical durability step. If it throws (IDB quota, private
      //    mode, transaction abort) we abort BEFORE committing auth so
      //    the user is never left authenticated without a private key.
      await saveKeypair(developerId, {
        publicKey: keypair.publicKey,
        secretKey: keypair.secretKey,
      });

      // 5. Only NOW commit auth tokens — the keypair is durable.
      setTokens(
        {
          access_token: result.data.access_token,
          refresh_token: result.data.refresh_token,
        },
        { persist: true },
      );
      tokensSet = true;

      if (wrappingKeyResult) {
        setWrappingKey(wrappingKeyResult);
      }

      // 6. Show the recovery modal instead of navigating immediately.
      //    The user has exactly one chance to save an offline backup of
      //    the private key; navigation happens after they dismiss it.
      setPostSignup({
        developerId,
        email,
        keypair,
        accessToken: result.data.access_token,
      });
    } catch (err) {
      // Roll back authentication if we already committed it. This only
      // fires for throws AFTER setTokens — throws before (generateKeyPair,
      // api.signup, developerIdFromAccessToken, saveKeypair) leave the
      // user cleanly un-authenticated.
      if (tokensSet) {
        clearTokens();
      }
      const message =
        err instanceof Error
          ? `Signup failed: ${err.message}`
          : "Signup failed: an unexpected error occurred";
      setError(message);
      // Don't re-throw — error is now contained in component state.
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
