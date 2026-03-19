import * as React from "react";
import { getAccessToken, getTokens } from "~/lib/auth-store";
import { startPasskeyRegistration } from "~/lib/passkey";
import { api } from "~/lib/api-client";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Input } from "~/components/ui/input";

interface PasskeyItem {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

interface OAuthIdentity {
  id: string;
  provider: string;
  email: string | null;
  created_at: string;
}

function getDeveloperIdFromToken(): string | null {
  const tokens = getTokens();
  if (!tokens?.access_token) return null;
  try {
    const payload = JSON.parse(atob(tokens.access_token.split(".")[1]));
    return payload.sub ?? null;
  } catch {
    return null;
  }
}

export function SettingsPage() {
  const [passkeys, setPasskeys] = React.useState<PasskeyItem[]>([]);
  const [oauthAccounts, setOauthAccounts] = React.useState<OAuthIdentity[]>(
    [],
  );
  const [passkeyName, setPasskeyName] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const fetchPasskeys = React.useCallback(async () => {
    const result = await api.fetch("/v1/auth/passkeys");
    if (result.ok) {
      setPasskeys(result.data as PasskeyItem[]);
    }
  }, []);

  const fetchOAuthAccounts = React.useCallback(async () => {
    const result = await api.fetch("/v1/auth/oauth/identities");
    if (result.ok) {
      setOauthAccounts(result.data as OAuthIdentity[]);
    }
  }, []);

  React.useEffect(() => {
    void fetchPasskeys();
    void fetchOAuthAccounts();
  }, [fetchPasskeys, fetchOAuthAccounts]);

  async function handleAddPasskey() {
    setError(null);
    setLoading(true);
    try {
      const accessToken = getAccessToken();
      const developerId = getDeveloperIdFromToken();
      if (!accessToken || !developerId) {
        setError("Not authenticated");
        return;
      }
      await startPasskeyRegistration(
        accessToken,
        developerId,
        passkeyName || undefined,
      );
      setPasskeyName("");
      await fetchPasskeys();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add passkey";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleDeletePasskey(credentialId: string) {
    const encodedId = encodeURIComponent(credentialId);
    const result = await api.fetch(`/v1/auth/passkeys/${encodedId}`, {
      method: "DELETE",
    });
    if (result.ok) {
      await fetchPasskeys();
    }
  }

  async function handleUnlinkOAuth(identityId: string) {
    const result = await api.fetch(`/v1/auth/oauth/identities/${identityId}`, {
      method: "DELETE",
    });
    if (result.ok) {
      await fetchOAuthAccounts();
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Security</CardTitle>
          <CardDescription>
            Manage your passkeys and linked OAuth accounts.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Passkeys Section */}
          <div>
            <h3 className="mb-3 text-lg font-medium">Passkeys</h3>

            {passkeys.length === 0 ? (
              <p
                className="mb-3 text-sm text-muted-foreground"
                data-testid="no-passkeys"
              >
                No passkeys registered.
              </p>
            ) : (
              <ul className="mb-3 space-y-2" data-testid="passkey-list">
                {passkeys.map((pk) => (
                  <li
                    key={pk.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div>
                      <p className="font-medium">
                        {pk.name ?? "Unnamed passkey"}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Added{" "}
                        {new Date(pk.created_at).toLocaleDateString()}
                        {pk.last_used_at &&
                          ` · Last used ${new Date(pk.last_used_at).toLocaleDateString()}`}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDeletePasskey(pk.id)}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex gap-2">
              <Input
                placeholder="Passkey name (optional)"
                value={passkeyName}
                onChange={(e) => setPasskeyName(e.target.value)}
                className="max-w-xs"
              />
              <Button onClick={handleAddPasskey} disabled={loading}>
                {loading ? "Adding..." : "Add Passkey"}
              </Button>
            </div>
          </div>

          {/* OAuth Accounts Section */}
          <div>
            <h3 className="mb-3 text-lg font-medium">
              Linked OAuth Accounts
            </h3>

            {oauthAccounts.length === 0 ? (
              <p
                className="text-sm text-muted-foreground"
                data-testid="no-oauth"
              >
                No OAuth accounts linked.
              </p>
            ) : (
              <ul className="space-y-2" data-testid="oauth-list">
                {oauthAccounts.map((acc) => (
                  <li
                    key={acc.id}
                    className="flex items-center justify-between rounded-md border p-3"
                  >
                    <div>
                      <p className="font-medium capitalize">{acc.provider}</p>
                      <p className="text-xs text-muted-foreground">
                        {acc.email ?? "No email"}
                        {" · Linked "}
                        {new Date(acc.created_at).toLocaleDateString()}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUnlinkOAuth(acc.id)}
                    >
                      Unlink
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
