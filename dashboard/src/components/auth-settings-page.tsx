import * as React from "react";
import { api } from "~/lib/api-client";
import { Card } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Badge } from "~/components/ui/badge";
import { Switch } from "~/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/tabs";

const BUILT_IN_ROLES = new Set(["anon", "authenticated", "service_role"]);

const selectClasses =
  "flex h-8 w-full rounded-lg border border-input bg-background text-foreground px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 [&>option]:bg-background [&>option]:text-foreground";

interface AuthSettingsPageProps {
  projectId: string;
  apiKey?: string;
}

// ── Providers Tab ──────────────────────────────────────────────────

function ProvidersTab({ projectId }: { projectId: string }) {
  const [providers, setProviders] = React.useState<string[]>([]);
  const [provider, setProvider] = React.useState("");
  const [clientId, setClientId] = React.useState("");
  const [clientSecret, setClientSecret] = React.useState("");

  const fetchProviders = React.useCallback(async () => {
    const res = await api.fetch(
      `/v1/projects/${projectId}/auth/providers`,
    );
    if (res.ok) {
      const data = res.data as { providers: string[] };
      setProviders(data.providers);
    }
  }, [projectId]);

  React.useEffect(() => {
    fetchProviders();
  }, [fetchProviders]);

  async function handleAdd() {
    await api.fetch(`/v1/projects/${projectId}/auth/providers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    setProvider("");
    setClientId("");
    setClientSecret("");
    fetchProviders();
  }

  async function handleRemove(name: string) {
    await api.fetch(`/v1/projects/${projectId}/auth/providers/${name}`, {
      method: "DELETE",
    });
    fetchProviders();
  }

  return (
    <div data-testid="providers-tab" className="space-y-6">
      <Card className="p-4">
        <h3 className="text-lg font-semibold mb-4">Configured Providers</h3>
        {providers.length === 0 ? (
          <p className="text-muted-foreground">No providers configured.</p>
        ) : (
          <ul className="space-y-2">
            {providers.map((p) => (
              <li key={p} className="flex items-center justify-between">
                <span>{p}</span>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => handleRemove(p)}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="text-lg font-semibold mb-4">Add Provider</h3>
        <div className="grid gap-4 max-w-md">
          <div>
            <Label htmlFor="provider-select">Provider</Label>
            <select
              id="provider-select"
              className={selectClasses}
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              <option value="">Select provider</option>
              <option value="google">google</option>
              <option value="github">github</option>
            </select>
          </div>
          <div>
            <Label htmlFor="client-id">Client ID</Label>
            <Input
              id="client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="client-secret">Client Secret</Label>
            <Input
              id="client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
          <Button onClick={handleAdd} disabled={!provider || !clientId || !clientSecret}>
            Add Provider
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Roles Tab ──────────────────────────────────────────────────────

interface Role {
  id: string;
  name: string;
  description: string | null;
  created_at: string | null;
}

function RolesTab({ projectId }: { projectId: string }) {
  const [roles, setRoles] = React.useState<Role[]>([]);
  const [roleName, setRoleName] = React.useState("");
  const [roleDesc, setRoleDesc] = React.useState("");

  const fetchRoles = React.useCallback(async () => {
    const res = await api.fetch(`/v1/projects/${projectId}/auth/roles`);
    if (res.ok) {
      setRoles(res.data as Role[]);
    }
  }, [projectId]);

  React.useEffect(() => {
    fetchRoles();
  }, [fetchRoles]);

  async function handleCreate() {
    await api.fetch(`/v1/projects/${projectId}/auth/roles`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: roleName, description: roleDesc }),
    });
    setRoleName("");
    setRoleDesc("");
    fetchRoles();
  }

  async function handleDelete(name: string) {
    await api.fetch(`/v1/projects/${projectId}/auth/roles/${name}`, {
      method: "DELETE",
    });
    fetchRoles();
  }

  return (
    <div data-testid="roles-tab" className="space-y-6">
      <Card className="p-4">
        <h3 className="text-lg font-semibold mb-4">Roles</h3>
        {roles.length === 0 ? (
          <p className="text-muted-foreground">No roles found.</p>
        ) : (
          <ul className="space-y-2">
            {roles.map((role) => (
              <li
                key={role.id}
                data-testid={`role-${role.name}`}
                className="flex items-center justify-between"
              >
                <div className="flex items-center gap-2">
                  <span>{role.name}</span>
                  {BUILT_IN_ROLES.has(role.name) && (
                    <Badge variant="secondary">built-in</Badge>
                  )}
                  {role.description && (
                    <span className="text-muted-foreground text-sm">
                      — {role.description}
                    </span>
                  )}
                </div>
                {!BUILT_IN_ROLES.has(role.name) && (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => handleDelete(role.name)}
                  >
                    Delete
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h3 className="text-lg font-semibold mb-4">Create Role</h3>
        <div className="grid gap-4 max-w-md">
          <div>
            <Label htmlFor="role-name">Role Name</Label>
            <Input
              id="role-name"
              value={roleName}
              onChange={(e) => setRoleName(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="role-desc">Description</Label>
            <Input
              id="role-desc"
              value={roleDesc}
              onChange={(e) => setRoleDesc(e.target.value)}
            />
          </div>
          <Button onClick={handleCreate} disabled={!roleName}>
            Create Role
          </Button>
        </div>
      </Card>
    </div>
  );
}

// ── Policies Tab ───────────────────────────────────────────────────

interface Policy {
  id: string;
  name: string;
  table_name: string;
  operation: string;
  role: string;
  condition: string;
  created_at: string;
}

interface TableInfo {
  name: string;
}

function PoliciesTab({
  projectId,
  apiKey,
}: {
  projectId: string;
  apiKey?: string;
}) {
  const [tables, setTables] = React.useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = React.useState("");
  const [policies, setPolicies] = React.useState<Policy[]>([]);
  const [roles, setRoles] = React.useState<Role[]>([]);

  // Policy form
  const [policyName, setPolicyName] = React.useState("");
  const [operation, setOperation] = React.useState("");
  const [role, setRole] = React.useState("");
  const [condition, setCondition] = React.useState("");

  React.useEffect(() => {
    async function load() {
      if (!apiKey) return;
      const res = await api.fetch("/v1/db/tables", {
        headers: { apikey: apiKey },
      });
      if (res.ok) {
        setTables(res.data as TableInfo[]);
      }
    }
    load();
  }, [apiKey]);

  React.useEffect(() => {
    async function load() {
      const res = await api.fetch(
        `/v1/projects/${projectId}/auth/roles`,
      );
      if (res.ok) {
        setRoles(res.data as Role[]);
      }
    }
    load();
  }, [projectId]);

  const fetchPolicies = React.useCallback(
    async (table: string) => {
      if (!table || !apiKey) return;
      const res = await api.fetch(
        `/v1/db/tables/${table}/policies`,
        { headers: { apikey: apiKey } },
      );
      if (res.ok) {
        setPolicies(res.data as Policy[]);
      }
    },
    [apiKey],
  );

  React.useEffect(() => {
    if (selectedTable) {
      fetchPolicies(selectedTable);
    }
  }, [selectedTable, fetchPolicies]);

  async function handleAddPolicy() {
    if (!selectedTable || !apiKey) return;
    await api.fetch(`/v1/db/tables/${selectedTable}/policies`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify({
        name: policyName,
        operation,
        role,
        condition,
      }),
    });
    setPolicyName("");
    setOperation("");
    setRole("");
    setCondition("");
    fetchPolicies(selectedTable);
  }

  async function handleDeletePolicy(policyId: string) {
    if (!selectedTable || !apiKey) return;
    await api.fetch(
      `/v1/db/tables/${selectedTable}/policies/${policyId}`,
      {
        method: "DELETE",
        headers: { apikey: apiKey },
      },
    );
    fetchPolicies(selectedTable);
  }

  return (
    <div data-testid="policies-tab" className="space-y-6">
      <Card className="p-4">
        <h3 className="text-lg font-semibold mb-4">Table Policies</h3>
        <div className="max-w-md mb-4">
          <Label htmlFor="table-select">Table</Label>
          <select
            id="table-select"
            className={selectClasses}
            value={selectedTable}
            onChange={(e) => setSelectedTable(e.target.value)}
          >
            <option value="">Select table</option>
            {tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name}
              </option>
            ))}
          </select>
        </div>

        {selectedTable && (
          <>
            {policies.length === 0 ? (
              <p className="text-muted-foreground">
                No policies for this table.
              </p>
            ) : (
              <ul className="space-y-2">
                {policies.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.name}</span>
                      <Badge variant="outline">{p.operation}</Badge>
                      <Badge variant="secondary">{p.role}</Badge>
                      <Badge>{p.condition}</Badge>
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleDeletePolicy(p.id)}
                    >
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {selectedTable && (
        <Card className="p-4">
          <h3 className="text-lg font-semibold mb-4">Add Policy</h3>
          <div className="grid gap-4 max-w-md">
            <div>
              <Label htmlFor="policy-name">Policy Name</Label>
              <Input
                id="policy-name"
                value={policyName}
                onChange={(e) => setPolicyName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="operation-select">Operation</Label>
              <select
                id="operation-select"
                className={selectClasses}
                value={operation}
                onChange={(e) => setOperation(e.target.value)}
              >
                <option value="">Select operation</option>
                <option value="select">select</option>
                <option value="insert">insert</option>
                <option value="update">update</option>
                <option value="delete">delete</option>
              </select>
            </div>
            <div>
              <Label htmlFor="role-select">Role</Label>
              <select
                id="role-select"
                className={selectClasses}
                value={role}
                onChange={(e) => setRole(e.target.value)}
              >
                <option value="">Select role</option>
                {roles.map((r) => (
                  <option key={r.id} value={r.name}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="condition-select">Condition</Label>
              <select
                id="condition-select"
                className={selectClasses}
                value={condition}
                onChange={(e) => setCondition(e.target.value)}
              >
                <option value="">Select condition</option>
                <option value="owner">owner</option>
                <option value="all">all</option>
                <option value="none">none</option>
              </select>
            </div>
            <Button
              onClick={handleAddPolicy}
              disabled={!policyName || !operation || !role || !condition}
            >
              Add Policy
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Settings Tab ───────────────────────────────────────────────────

interface AuthSettings {
  require_email_verification: boolean;
  password_min_length: number;
  mfa_enabled: boolean;
  magic_link_webhook: string | null;
}

function SettingsTab({ projectId }: { projectId: string }) {
  const [settings, setSettings] = React.useState<AuthSettings | null>(null);
  const [emailVerification, setEmailVerification] = React.useState(false);
  const [passwordMinLength, setPasswordMinLength] = React.useState(8);
  const [mfaEnabled, setMfaEnabled] = React.useState(false);
  const [webhookUrl, setWebhookUrl] = React.useState("");

  React.useEffect(() => {
    async function load() {
      const res = await api.fetch(
        `/v1/projects/${projectId}/auth/settings`,
      );
      if (res.ok) {
        const data = res.data as AuthSettings;
        setSettings(data);
        setEmailVerification(data.require_email_verification);
        setPasswordMinLength(data.password_min_length);
        setMfaEnabled(data.mfa_enabled);
        setWebhookUrl(data.magic_link_webhook ?? "");
      }
    }
    load();
  }, [projectId]);

  async function handleSave() {
    await api.fetch(`/v1/projects/${projectId}/auth/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        require_email_verification: emailVerification,
        password_min_length: passwordMinLength,
        mfa_enabled: mfaEnabled,
        magic_link_webhook: webhookUrl || null,
      }),
    });
  }

  if (!settings) {
    return <p className="text-muted-foreground">Loading settings...</p>;
  }

  return (
    <div data-testid="settings-tab">
      <Card className="p-4">
        <h3 className="text-lg font-semibold mb-4">Auth Settings</h3>
        <div className="grid gap-6 max-w-md">
          <div className="flex items-center justify-between">
            <Label htmlFor="email-verification">
              Require Email Verification
            </Label>
            <Switch
              id="email-verification"
              checked={emailVerification}
              onCheckedChange={setEmailVerification}
            />
          </div>
          <div>
            <Label htmlFor="password-min">Minimum Password Length</Label>
            <Input
              id="password-min"
              type="number"
              min={6}
              max={128}
              value={passwordMinLength}
              onChange={(e) =>
                setPasswordMinLength(parseInt(e.target.value, 10) || 8)
              }
            />
          </div>
          <div className="flex items-center justify-between">
            <Label htmlFor="mfa-enabled">Enable MFA</Label>
            <Switch
              id="mfa-enabled"
              checked={mfaEnabled}
              onCheckedChange={setMfaEnabled}
            />
          </div>
          <div>
            <Label htmlFor="webhook-url">Webhook URL</Label>
            <Input
              id="webhook-url"
              type="url"
              placeholder="https://example.com/webhook"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
            />
          </div>
          <Button onClick={handleSave}>Save Settings</Button>
        </div>
      </Card>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────

export function AuthSettingsPage({ projectId, apiKey }: AuthSettingsPageProps) {
  return (
    <div>
      <h2 className="text-2xl font-bold mb-6">Authentication</h2>
      <Tabs defaultValue="providers">
        <TabsList>
          <TabsTrigger value="providers">Providers</TabsTrigger>
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="policies">Policies</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="providers">
          <ProvidersTab projectId={projectId} />
        </TabsContent>
        <TabsContent value="roles">
          <RolesTab projectId={projectId} />
        </TabsContent>
        <TabsContent value="policies">
          <PoliciesTab projectId={projectId} apiKey={apiKey} />
        </TabsContent>
        <TabsContent value="settings">
          <SettingsTab projectId={projectId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
