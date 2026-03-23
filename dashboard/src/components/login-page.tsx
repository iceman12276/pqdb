import * as React from "react";
import { api } from "~/lib/api-client";
import { setTokens } from "~/lib/auth-store";
import { useNavigate } from "~/lib/navigation";
import { isValidEmail } from "~/lib/validation";
import { startPasskeyAuthentication } from "~/lib/passkey";
import { getMcpCallbackParams, handleMcpRedirect } from "~/lib/mcp-callback";
import { deriveWrappingKey, unwrapKey } from "~/lib/envelope-crypto";
import { useEnvelopeKeys } from "~/lib/envelope-key-context";
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

function getOAuthRedirectUri(): string {
  // Preserve query params (mcp_callback, request_id) through the OAuth round-trip
  const search = window.location.search;
  return `${window.location.origin}/login${search}`;
}

export function LoginPage() {
  const navigate = useNavigate();
  const { setWrappingKey } = useEnvelopeKeys();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  // Handle OAuth callback: extract tokens from URL hash fragment
  React.useEffect(() => {
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.substring(1));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      if (accessToken && refreshToken) {
        setTokens(
          { access_token: accessToken, refresh_token: refreshToken },
          { persist: true },
        );
        // Clear the hash to avoid re-processing
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        if (!handleMcpRedirect(accessToken)) {
          navigate({ to: "/projects" });
        }
      }
    }
  }, [navigate]);

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

    setLoading(true);
    try {
      // Run PBKDF2 derivation in parallel with login API call to hide latency
      const [result, wrappingKeyResult] = await Promise.all([
        api.login(email, password),
        deriveWrappingKey(password, email).catch((err) => { console.warn("[pqdb] Failed to derive wrapping key:", err); return null; }),
      ]);

      if (result.error) {
        setError(result.error.message);
      } else {
        setTokens(
          {
            access_token: result.data.access_token,
            refresh_token: result.data.refresh_token,
          },
          { persist: true },
        );

        // Store wrapping key before navigating (password is lost after navigation)
        if (wrappingKeyResult) {
          setWrappingKey(wrappingKeyResult);
        }

        // For MCP OAuth flow: unwrap the first project's encryption key
        // so the MCP server can auto-decrypt without PQDB_ENCRYPTION_KEY
        let encryptionKey: string | undefined;
        const mcpParams = getMcpCallbackParams();
        if (mcpParams.mcp_callback && wrappingKeyResult) {
          try {
            const projRes = await fetch("/v1/projects", {
              headers: { Authorization: `Bearer ${result.data.access_token}` },
            });
            if (projRes.ok) {
              const projects = (await projRes.json()) as Array<{
                id: string;
                wrapped_encryption_key: string | null;
              }>;
              const projectWithKey = projects.find(
                (p) => p.wrapped_encryption_key,
              );
              if (projectWithKey?.wrapped_encryption_key) {
                const blob = Uint8Array.from(
                  atob(projectWithKey.wrapped_encryption_key),
                  (c) => c.charCodeAt(0),
                );
                encryptionKey = await unwrapKey(blob, wrappingKeyResult);
              }
            }
          } catch (err) {
            console.warn("[pqdb] Failed to unwrap encryption key for MCP:", err);
          }
        }

        if (!handleMcpRedirect(result.data.access_token, encryptionKey)) {
          navigate({ to: "/projects" });
        }
      }
    } finally {
      setLoading(false);
    }
  }

  function handleOAuthLogin(provider: "google" | "github") {
    const redirectUri = encodeURIComponent(getOAuthRedirectUri());
    window.location.href =
      `/v1/auth/oauth/${provider}/authorize?redirect_uri=${redirectUri}`;
  }

  async function handlePasskeyLogin() {
    setError(null);
    setLoading(true);
    try {
      const tokens = await startPasskeyAuthentication();
      setTokens(tokens, { persist: true });
      if (!handleMcpRedirect(tokens.access_token)) {
        navigate({ to: "/projects" });
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Passkey authentication failed";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-2xl">Sign in to pqdb</CardTitle>
          <CardDescription>
            Welcome back. Enter your credentials to continue.
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
                placeholder="Enter your password"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <Button type="submit" disabled={loading} className="w-full">
              {loading ? "Signing in..." : "Sign in"}
            </Button>
          </form>

          <div className="relative my-4">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t border-border" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-card px-2 text-muted-foreground">
                Or continue with
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={() => handleOAuthLogin("google")}
            >
              Sign in with Google
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={() => handleOAuthLogin("github")}
            >
              Sign in with GitHub
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={loading}
              onClick={handlePasskeyLogin}
            >
              Sign in with Passkey
            </Button>
          </div>
        </CardContent>

        <CardFooter className="justify-center">
          <p className="text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <a href="/signup" className="text-primary hover:underline">
              Sign up
            </a>
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
