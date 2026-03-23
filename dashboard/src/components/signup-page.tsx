import * as React from "react";
import { api } from "~/lib/api-client";
import { setTokens } from "~/lib/auth-store";
import { useNavigate } from "~/lib/navigation";
import { isValidEmail } from "~/lib/validation";
import { handleMcpRedirect } from "~/lib/mcp-callback";
import { deriveWrappingKey } from "~/lib/envelope-crypto";
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

export function SignupPage() {
  const navigate = useNavigate();
  const { setWrappingKey } = useEnvelopeKeys();
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

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
      // Run PBKDF2 derivation in parallel with signup API call to hide latency
      const [result, wrappingKeyResult] = await Promise.all([
        api.signup(email, password),
        deriveWrappingKey(password, email).catch(() => null),
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

        if (!handleMcpRedirect(result.data.access_token)) {
          navigate({ to: "/projects" });
        }
      }
    } finally {
      setLoading(false);
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
    </div>
  );
}
