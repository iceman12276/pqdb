import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  MCP_TOOLS,
  buildMcpConfigSnippet,
  executeMcpTool,
  type McpTool,
} from "~/lib/mcp";

const CATEGORY_LABELS: Record<string, string> = {
  status: "Status",
  schema: "Schema",
  crud: "CRUD",
  auth: "Auth",
  query: "Query",
};

function groupToolsByCategory(tools: McpTool[]): Record<string, McpTool[]> {
  const groups: Record<string, McpTool[]> = {};
  for (const tool of tools) {
    const cat = tool.category;
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(tool);
  }
  return groups;
}

export function McpPage({ projectId }: { projectId: string }) {
  const [selectedTool, setSelectedTool] = React.useState<string>("");
  const [paramValues, setParamValues] = React.useState<
    Record<string, string>
  >({});
  const [executing, setExecuting] = React.useState(false);
  const [toolResult, setToolResult] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const configSnippet = buildMcpConfigSnippet(projectId);
  const configJson = JSON.stringify(configSnippet, null, 2);

  const currentTool = MCP_TOOLS.find((t) => t.name === selectedTool);
  const groupedTools = groupToolsByCategory(MCP_TOOLS);

  function handleToolChange(name: string) {
    setSelectedTool(name);
    setParamValues({});
    setToolResult(null);
  }

  function handleParamChange(paramName: string, value: string) {
    setParamValues((prev) => ({ ...prev, [paramName]: value }));
  }

  async function handleExecute() {
    if (!selectedTool) return;
    setExecuting(true);
    setToolResult(null);
    try {
      const result = await executeMcpTool(projectId, selectedTool, paramValues);
      setToolResult(JSON.stringify(result, null, 2));
    } catch (err) {
      setToolResult(
        JSON.stringify(
          {
            error: err instanceof Error ? err.message : "Execution failed",
          },
          null,
          2,
        ),
      );
    } finally {
      setExecuting(false);
    }
  }

  async function handleCopyConfig() {
    await navigator.clipboard.writeText(JSON.stringify(configSnippet, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">MCP Server</h1>
        <Badge variant="secondary">{MCP_TOOLS.length} tools</Badge>
      </div>

      {/* Connection Info */}
      <Card data-testid="mcp-connection-info">
        <CardHeader>
          <CardTitle>Connection Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label className="text-xs text-muted-foreground uppercase">
              stdio command
            </Label>
            <pre className="mt-1 rounded-md bg-muted p-3 text-sm font-mono overflow-x-auto">
              PQDB_API_KEY=&lt;key&gt; npx pqdb-mcp --project-url
              https://localhost
            </pre>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground uppercase">
              SSE command
            </Label>
            <pre className="mt-1 rounded-md bg-muted p-3 text-sm font-mono overflow-x-auto">
              PQDB_API_KEY=&lt;key&gt; npx pqdb-mcp --project-url
              https://localhost --transport sse --port 3001
            </pre>
          </div>

          <div>
            <Label className="text-xs text-muted-foreground uppercase">
              Required Environment Variables
            </Label>
            <div className="mt-1 space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline">
                  <code>PQDB_API_KEY</code>
                </Badge>
                <span className="text-sm text-muted-foreground">
                  Your project API key (anon or service_role)
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">
                  <code>PQDB_PROJECT_URL</code>
                </Badge>
                <span className="text-sm text-muted-foreground">
                  URL of your pqdb API server
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant="outline">
                  <code>PQDB_ENCRYPTION_KEY</code>
                </Badge>
                <span className="text-sm text-muted-foreground">
                  Optional — enables client-side decryption of sensitive columns
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* MCP Config Snippet */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>MCP Config Snippet</span>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyConfig}
              data-testid="copy-mcp-config"
            >
              {copied ? "Copied!" : "Copy to Clipboard"}
            </Button>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <pre
            className="rounded-md bg-muted p-3 text-sm font-mono overflow-x-auto"
            data-testid="mcp-config-snippet"
          >
            {configJson}
          </pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Paste this into your Claude Code, Cursor, or other MCP client
            configuration.
          </p>
        </CardContent>
      </Card>

      {/* Tools List */}
      <Card>
        <CardHeader>
          <CardTitle>Available Tools</CardTitle>
        </CardHeader>
        <CardContent data-testid="mcp-tools-list">
          <div className="space-y-4">
            {Object.entries(groupedTools).map(([category, tools]) => (
              <div key={category}>
                <h3 className="text-sm font-semibold mb-2">
                  {CATEGORY_LABELS[category] ?? category}
                </h3>
                <div className="space-y-2">
                  {tools.map((tool) => (
                    <div
                      key={tool.name}
                      className="flex items-start gap-3 rounded-md border border-border p-3"
                    >
                      <div className="flex-1">
                        <code className="text-sm font-semibold">
                          {tool.name}
                        </code>
                        <p className="text-sm text-muted-foreground mt-0.5">
                          {tool.description}
                        </p>
                        {Object.keys(tool.parameters).length > 0 && (
                          <div className="mt-1 flex gap-1 flex-wrap">
                            {Object.entries(tool.parameters).map(
                              ([name, param]) => (
                                <Badge
                                  key={name}
                                  variant="secondary"
                                  className="text-xs"
                                >
                                  {name}: {param.type}
                                </Badge>
                              ),
                            )}
                          </div>
                        )}
                      </div>
                      <Badge variant="outline" className="text-xs shrink-0">
                        {CATEGORY_LABELS[tool.category] ?? tool.category}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Test Tool */}
      <Card data-testid="mcp-test-tool">
        <CardHeader>
          <CardTitle>Test Tool</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="tool-select">Select a tool</Label>
            <Select value={selectedTool} onValueChange={(v) => { if (v) handleToolChange(v); }}>
              <SelectTrigger id="tool-select">
                <SelectValue placeholder="Choose a tool..." />
              </SelectTrigger>
              <SelectContent>
                {MCP_TOOLS.map((tool) => (
                  <SelectItem key={tool.name} value={tool.name}>
                    {tool.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {currentTool &&
            Object.keys(currentTool.parameters).length > 0 && (
              <div className="space-y-2">
                {Object.entries(currentTool.parameters).map(
                  ([name, param]) => (
                    <div key={name}>
                      <Label htmlFor={`param-${name}`}>
                        {name}{" "}
                        <span className="text-muted-foreground">
                          ({param.type})
                        </span>
                      </Label>
                      <Input
                        id={`param-${name}`}
                        placeholder={param.description}
                        value={paramValues[name] ?? ""}
                        onChange={(e) =>
                          handleParamChange(name, e.target.value)
                        }
                      />
                    </div>
                  ),
                )}
              </div>
            )}

          <Button
            onClick={handleExecute}
            disabled={!selectedTool || executing}
            data-testid="execute-tool-button"
          >
            {executing ? "Executing..." : "Execute"}
          </Button>

          {toolResult && (
            <pre
              className="mt-2 rounded-md bg-muted p-3 text-sm font-mono overflow-x-auto max-h-96 overflow-y-auto"
              data-testid="tool-result"
            >
              {toolResult}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
