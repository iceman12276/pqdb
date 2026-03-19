import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  Background,
  Controls,
  MiniMap,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { KeyRound, Plus } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Skeleton } from "~/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { ErdTableNode, type TableNodeData } from "~/components/erd-table-node";
import {
  fetchSchema,
  addColumn,
  getPhysicalColumns,
  type IntrospectionTable,
  type IntrospectionColumn,
  type Sensitivity,
} from "~/lib/schema";

interface SchemaPageProps {
  projectId: string;
  apiKey: string;
}

const sensitivityColors: Record<string, string> = {
  plain: "bg-muted text-muted-foreground",
  searchable: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  private:
    "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
};

const nodeTypes: NodeTypes = {
  tableNode: ErdTableNode,
};

function buildNodesAndEdges(
  tables: IntrospectionTable[],
  viewMode: "logical" | "physical",
): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = tables.map((table, idx) => ({
    id: table.name,
    type: "tableNode",
    position: { x: (idx % 3) * 320, y: Math.floor(idx / 3) * 400 },
    data: {
      label: table.name,
      columns: table.columns,
      viewMode,
    } satisfies TableNodeData,
  }));

  // Build edges from foreign-key-like columns (columns ending with _id that match another table name)
  const tableNames = new Set(tables.map((t) => t.name));
  const edges: Edge[] = [];

  for (const table of tables) {
    for (const col of table.columns) {
      if (col.name.endsWith("_id")) {
        const refTable = col.name.replace(/_id$/, "") + "s"; // simple pluralization
        if (tableNames.has(refTable) && refTable !== table.name) {
          edges.push({
            id: `${table.name}-${col.name}-${refTable}`,
            source: table.name,
            target: refTable,
            animated: true,
            label: col.name,
            style: { stroke: "var(--color-primary)" },
          });
        }
        // Also check singular
        const refTableSingular = col.name.replace(/_id$/, "");
        if (
          tableNames.has(refTableSingular) &&
          refTableSingular !== table.name &&
          refTableSingular !== refTable
        ) {
          edges.push({
            id: `${table.name}-${col.name}-${refTableSingular}`,
            source: table.name,
            target: refTableSingular,
            animated: true,
            label: col.name,
            style: { stroke: "var(--color-primary)" },
          });
        }
      }
    }
  }

  return { nodes, edges };
}

function ColumnRow({
  column,
  viewMode,
}: {
  column: IntrospectionColumn;
  viewMode: "logical" | "physical";
}) {
  if (viewMode === "physical") {
    const physicalCols = getPhysicalColumns(column);
    return (
      <>
        {physicalCols.map((pc, idx) => (
          <div
            key={`${pc.name}-${idx}`}
            className="flex items-center gap-2 py-1"
          >
            {column.is_owner && idx === 0 && (
              <KeyRound
                className="h-3.5 w-3.5 text-amber-500 shrink-0"
                data-testid="owner-icon"
              />
            )}
            {!(column.is_owner && idx === 0) && (
              <span className="w-3.5 shrink-0" />
            )}
            <span className="font-mono text-sm flex-1">{pc.name}</span>
            <span className="text-xs text-muted-foreground">{pc.type}</span>
            <Badge
              data-testid={`badge-${column.sensitivity}`}
              className={`text-[10px] ${sensitivityColors[column.sensitivity] ?? ""}`}
            >
              {column.sensitivity}
            </Badge>
          </div>
        ))}
      </>
    );
  }

  return (
    <div className="flex items-center gap-2 py-1">
      {column.is_owner ? (
        <KeyRound
          className="h-3.5 w-3.5 text-amber-500 shrink-0"
          data-testid="owner-icon"
        />
      ) : (
        <span className="w-3.5 shrink-0" />
      )}
      <span className="font-mono text-sm flex-1">{column.name}</span>
      <span className="text-xs text-muted-foreground">{column.type}</span>
      <Badge
        data-testid={`badge-${column.sensitivity}`}
        className={`text-[10px] ${sensitivityColors[column.sensitivity] ?? ""}`}
      >
        {column.sensitivity}
      </Badge>
    </div>
  );
}

function AddColumnDialog({
  tableName,
  apiKey,
  onSuccess,
}: {
  tableName: string;
  apiKey: string;
  onSuccess: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [dataType, setDataType] = React.useState("text");
  const [sensitivity, setSensitivity] = React.useState<Sensitivity>("plain");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await addColumn(
        tableName,
        { name, data_type: dataType, sensitivity, owner: false },
        apiKey,
      );
      setOpen(false);
      setName("");
      setDataType("text");
      setSensitivity("plain");
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add column");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Column
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add Column to {tableName}</DialogTitle>
          <DialogDescription>
            Add a new column to the {tableName} table.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="col-name">Column Name</Label>
            <Input
              id="col-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="column_name"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="col-type">Data Type</Label>
            <Select value={dataType} onValueChange={(v) => { if (v) setDataType(v); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="text">text</SelectItem>
                <SelectItem value="uuid">uuid</SelectItem>
                <SelectItem value="integer">integer</SelectItem>
                <SelectItem value="bigint">bigint</SelectItem>
                <SelectItem value="boolean">boolean</SelectItem>
                <SelectItem value="timestamp">timestamp</SelectItem>
                <SelectItem value="jsonb">jsonb</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="col-sensitivity">Sensitivity</Label>
            <Select
              value={sensitivity}
              onValueChange={(v) => { if (v) setSensitivity(v as Sensitivity); }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="plain">Plain (queryable)</SelectItem>
                <SelectItem value="searchable">
                  Searchable (encrypted + blind index)
                </SelectItem>
                <SelectItem value="private">
                  Private (encrypted only)
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting || !name}>
              {submitting ? "Adding..." : "Add Column"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ErdView({
  tables,
  viewMode,
}: {
  tables: IntrospectionTable[];
  viewMode: "logical" | "physical";
}) {
  const { nodes: initialNodes, edges: initialEdges } = React.useMemo(
    () => buildNodesAndEdges(tables, viewMode),
    [tables, viewMode],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Update nodes when viewMode or tables change
  React.useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = buildNodesAndEdges(
      tables,
      viewMode,
    );
    setNodes(newNodes);
    setEdges(newEdges);
  }, [tables, viewMode, setNodes, setEdges]);

  return (
    <div data-testid="erd-view" className="h-[600px] w-full rounded-lg border border-border">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.1}
        maxZoom={2}
      >
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}

function ListView({
  tables,
  viewMode,
  apiKey,
  onColumnAdded,
}: {
  tables: IntrospectionTable[];
  viewMode: "logical" | "physical";
  apiKey: string;
  onColumnAdded: () => void;
}) {
  return (
    <div className="space-y-4">
      {tables.map((table) => (
        <Card key={table.name}>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>{table.name}</CardTitle>
              <div className="flex gap-2 mt-1">
                {table.sensitivity_summary.plain > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {table.sensitivity_summary.plain} plain
                  </span>
                )}
                {table.sensitivity_summary.searchable > 0 && (
                  <span className="text-xs text-blue-600">
                    {table.sensitivity_summary.searchable} searchable
                  </span>
                )}
                {table.sensitivity_summary.private > 0 && (
                  <span className="text-xs text-purple-600">
                    {table.sensitivity_summary.private} private
                  </span>
                )}
              </div>
            </div>
            <AddColumnDialog
              tableName={table.name}
              apiKey={apiKey}
              onSuccess={onColumnAdded}
            />
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-border">
              {table.columns.map((col) => (
                <ColumnRow
                  key={col.name}
                  column={col}
                  viewMode={viewMode}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export function SchemaPage({ projectId, apiKey }: SchemaPageProps) {
  const [viewMode, setViewMode] = React.useState<"logical" | "physical">(
    "logical",
  );
  const queryClient = useQueryClient();

  const {
    data: tables,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["schema", projectId, apiKey],
    queryFn: () => fetchSchema(apiKey),
    enabled: !!apiKey,
  });

  function handleColumnAdded() {
    queryClient.invalidateQueries({ queryKey: ["schema", projectId, apiKey] });
  }

  if (isLoading) {
    return (
      <div data-testid="schema-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {error instanceof Error ? error.message : "Failed to fetch schema"}
        </p>
      </div>
    );
  }

  if (!tables || tables.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground">
          No tables yet. Create a table using the SDK or API to see your schema
          here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Schema</h2>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">View:</span>
          <Button
            variant={viewMode === "logical" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("logical")}
          >
            Logical
          </Button>
          <Button
            variant={viewMode === "physical" ? "default" : "outline"}
            size="sm"
            onClick={() => setViewMode("physical")}
          >
            Physical
          </Button>
        </div>
      </div>

      <Tabs defaultValue="list">
        <TabsList>
          <TabsTrigger value="list">List</TabsTrigger>
          <TabsTrigger value="erd">ERD</TabsTrigger>
        </TabsList>
        <TabsContent value="list">
          <ListView
            tables={tables}
            viewMode={viewMode}
            apiKey={apiKey}
            onColumnAdded={handleColumnAdded}
          />
        </TabsContent>
        <TabsContent value="erd">
          <ErdView tables={tables} viewMode={viewMode} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
