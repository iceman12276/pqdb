import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ReactFlow,
  useNodesState,
  useEdgesState,
  useReactFlow,
  ReactFlowProvider,
  type Node,
  type Edge,
  type NodeTypes,
  type EdgeTypes,
  Position,
  Background,
  Controls,
  MiniMap,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { KeyRound, Plus, Trash2, LayoutGrid, Copy, Check } from "lucide-react";
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
  fetchIndexes,
  createIndex,
  dropIndex,
  fetchForeignKeys,
  fetchSchemas,
  type IntrospectionTable,
  type IntrospectionColumn,
  type ForeignKeyInfo,
  type Sensitivity,
  type VectorIndex,
  type IndexType,
  type IndexDistance,
} from "~/lib/schema";
import { applyDagreLayout } from "~/lib/auto-layout";
import { generateCreateTableSQL, type ForeignKey } from "~/lib/generate-sql";

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

/**
 * Custom FK edge with hover label showing source.column -> target.column.
 */
function ForeignKeyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  data?: { fkLabel?: string };
}) {
  const [hovered, setHovered] = React.useState(false);
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <>
      {/* Invisible wider path for hover target */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: "var(--color-primary)",
          strokeWidth: 2,
          animation: "dashdraw 0.5s linear infinite",
          strokeDasharray: "5 5",
        }}
      />
      {hovered && data?.fkLabel && (
        <EdgeLabelRenderer>
          <div
            data-testid={`fk-label-${id}`}
            className="absolute bg-popover text-popover-foreground border border-border rounded px-2 py-1 text-xs font-mono shadow-md pointer-events-none"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            }}
          >
            {data.fkLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes: EdgeTypes = {
  fk: ForeignKeyEdge as EdgeTypes["default"],
};

function buildNodesAndEdges(
  tables: IntrospectionTable[],
  foreignKeys: ForeignKeyInfo[],
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

  const tableNames = new Set(tables.map((t) => t.name));
  const edges: Edge[] = [];

  if (foreignKeys.length > 0) {
    // Use real FK data from information_schema
    for (const fk of foreignKeys) {
      if (tableNames.has(fk.source_table) && tableNames.has(fk.target_table)) {
        edges.push({
          id: `fk-${fk.constraint_name}`,
          source: fk.source_table,
          target: fk.target_table,
          type: "fk",
          animated: true,
          data: {
            fkLabel: `${fk.source_table}.${fk.source_column} → ${fk.target_table}.${fk.target_column}`,
          },
        });
      }
    }
  } else {
    // Fallback: heuristic FK detection from column names
    for (const table of tables) {
      for (const col of table.columns) {
        if (col.name.endsWith("_id")) {
          const refTable = col.name.replace(/_id$/, "") + "s";
          if (tableNames.has(refTable) && refTable !== table.name) {
            edges.push({
              id: `${table.name}-${col.name}-${refTable}`,
              source: table.name,
              target: refTable,
              type: "fk",
              animated: true,
              data: {
                fkLabel: `${table.name}.${col.name} → ${refTable}.id`,
              },
            });
          }
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
              type: "fk",
              animated: true,
              data: {
                fkLabel: `${table.name}.${col.name} → ${refTableSingular}.id`,
              },
            });
          }
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

function CreateIndexDialog({
  tableName,
  columns,
  apiKey,
  onSuccess,
}: {
  tableName: string;
  columns: IntrospectionColumn[];
  apiKey: string;
  onSuccess: () => void;
}) {
  const vectorColumns = columns.filter(
    (c) => c.sensitivity === "plain" && c.type.startsWith("vector("),
  );

  const [open, setOpen] = React.useState(false);
  const [column, setColumn] = React.useState(vectorColumns[0]?.name ?? "");
  const [indexType, setIndexType] = React.useState<IndexType>("hnsw");
  const [distance, setDistance] = React.useState<IndexDistance>("cosine");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (vectorColumns.length === 0) {
    return null;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createIndex(
        tableName,
        { column, type: indexType, distance },
        apiKey,
      );
      setOpen(false);
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create index");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm" data-testid="create-index-btn">
            <Plus className="h-3.5 w-3.5 mr-1" />
            Create Index
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create Vector Index on {tableName}</DialogTitle>
          <DialogDescription>
            Create a vector index to speed up similarity searches.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="idx-column">Column</Label>
            <Select value={column} onValueChange={(v) => { if (v) setColumn(v); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {vectorColumns.map((c) => (
                  <SelectItem key={c.name} value={c.name}>
                    {c.name} ({c.type})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="idx-type">Index Type</Label>
            <Select value={indexType} onValueChange={(v) => { if (v) setIndexType(v as IndexType); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hnsw">HNSW (recommended)</SelectItem>
                <SelectItem value="ivfflat">IVFFlat</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="idx-distance">Distance Metric</Label>
            <Select value={distance} onValueChange={(v) => { if (v) setDistance(v as IndexDistance); }}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cosine">Cosine</SelectItem>
                <SelectItem value="l2">L2 (Euclidean)</SelectItem>
                <SelectItem value="inner_product">Inner Product</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={submitting || !column}>
              {submitting ? "Creating..." : "Create Index"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IndexesSection({
  tableName,
  columns,
  apiKey,
}: {
  tableName: string;
  columns: IntrospectionColumn[];
  apiKey: string;
}) {
  const queryClient = useQueryClient();
  const hasVectorColumns = columns.some(
    (c) => c.sensitivity === "plain" && c.type.startsWith("vector("),
  );

  const {
    data: indexes,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["indexes", tableName, apiKey],
    queryFn: () => fetchIndexes(tableName, apiKey),
    enabled: !!apiKey && hasVectorColumns,
  });

  const [dropping, setDropping] = React.useState<string | null>(null);

  if (!hasVectorColumns) {
    return null;
  }

  function handleRefresh() {
    queryClient.invalidateQueries({ queryKey: ["indexes", tableName, apiKey] });
  }

  async function handleDrop(indexName: string) {
    setDropping(indexName);
    try {
      await dropIndex(tableName, indexName, apiKey);
      handleRefresh();
    } catch {
      // Silently fail — user can retry
    } finally {
      setDropping(null);
    }
  }

  return (
    <div className="mt-3 pt-3 border-t border-border" data-testid="indexes-section">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium">Indexes</span>
        <CreateIndexDialog
          tableName={tableName}
          columns={columns}
          apiKey={apiKey}
          onSuccess={handleRefresh}
        />
      </div>
      {isLoading && (
        <p className="text-xs text-muted-foreground">Loading indexes...</p>
      )}
      {error && (
        <p className="text-xs text-destructive">Failed to load indexes</p>
      )}
      {indexes && indexes.length === 0 && (
        <p className="text-xs text-muted-foreground">No indexes</p>
      )}
      {indexes && indexes.length > 0 && (
        <div className="space-y-1">
          {indexes.map((idx) => (
            <div
              key={idx.index_name}
              className="flex items-center justify-between text-sm py-1"
              data-testid={`index-row-${idx.index_name}`}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs">{idx.index_name}</span>
                <Badge className="text-[10px] bg-muted text-muted-foreground">
                  {idx.type}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {idx.distance}
                </span>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 w-6 p-0 text-destructive hover:text-destructive"
                onClick={() => handleDrop(idx.index_name)}
                disabled={dropping === idx.index_name}
                data-testid={`drop-index-${idx.index_name}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ErdViewInner({
  tables,
  foreignKeys,
  viewMode,
}: {
  tables: IntrospectionTable[];
  foreignKeys: ForeignKeyInfo[];
  viewMode: "logical" | "physical";
}) {
  const { fitView } = useReactFlow();
  const [copied, setCopied] = React.useState(false);

  const { nodes: initialNodes, edges: initialEdges } = React.useMemo(
    () => buildNodesAndEdges(tables, foreignKeys, viewMode),
    [tables, foreignKeys, viewMode],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges);

  // Update nodes when viewMode, tables, or foreignKeys change
  React.useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = buildNodesAndEdges(
      tables,
      foreignKeys,
      viewMode,
    );
    setNodes(newNodes);
    setEdges(newEdges);
  }, [tables, foreignKeys, viewMode, setNodes, setEdges]);

  function handleAutoLayout() {
    const layoutNodes = applyDagreLayout(nodes, edges);
    setNodes(layoutNodes);
    // Fit view after a small delay to let React re-render positions
    setTimeout(() => fitView({ padding: 0.2 }), 50);
  }

  function handleCopySQL() {
    const fks: ForeignKey[] = foreignKeys.map((fk) => ({
      constraint_name: fk.constraint_name,
      source_table: fk.source_table,
      source_column: fk.source_column,
      target_table: fk.target_table,
      target_column: fk.target_column,
    }));
    const sql = generateCreateTableSQL(tables, fks, viewMode);
    navigator.clipboard.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch((err) => {
      console.error("Failed to copy SQL to clipboard:", err);
    });
  }

  return (
    <div data-testid="erd-view" className="space-y-2">
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleAutoLayout}
          data-testid="auto-layout-btn"
        >
          <LayoutGrid className="h-3.5 w-3.5 mr-1" />
          Auto Layout
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleCopySQL}
          data-testid="copy-sql-btn"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 mr-1" />
          ) : (
            <Copy className="h-3.5 w-3.5 mr-1" />
          )}
          {copied ? "Copied!" : "Copy as SQL"}
        </Button>
      </div>
      <div className="h-[600px] w-full rounded-lg border border-border">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.1}
          maxZoom={2}
        >
          <Background />
          <Controls className="!bg-background !border-border !shadow-none [&_button]:!bg-background [&_button]:!border-border [&_button]:!fill-foreground [&_button:hover]:!bg-muted" />
          <MiniMap className="!bg-background !border-border" nodeColor="hsl(var(--muted-foreground))" maskColor="hsl(var(--muted) / 0.7)" />
        </ReactFlow>
      </div>
    </div>
  );
}

function ErdView({
  tables,
  foreignKeys,
  viewMode,
}: {
  tables: IntrospectionTable[];
  foreignKeys: ForeignKeyInfo[];
  viewMode: "logical" | "physical";
}) {
  return (
    <ReactFlowProvider>
      <ErdViewInner tables={tables} foreignKeys={foreignKeys} viewMode={viewMode} />
    </ReactFlowProvider>
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
            <IndexesSection
              tableName={table.name}
              columns={table.columns}
              apiKey={apiKey}
            />
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
  const [selectedSchema, setSelectedSchema] = React.useState("public");
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

  const { data: foreignKeys } = useQuery({
    queryKey: ["foreignKeys", projectId, apiKey, selectedSchema],
    queryFn: () => fetchForeignKeys(apiKey, selectedSchema),
    enabled: !!apiKey,
  });

  const { data: schemas } = useQuery({
    queryKey: ["schemas", projectId, apiKey],
    queryFn: () => fetchSchemas(apiKey),
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

  const availableSchemas = schemas ?? ["public"];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Schema</h2>
        <div className="flex items-center gap-2">
          <Select
            value={selectedSchema}
            onValueChange={(v) => { if (v) setSelectedSchema(v); }}
          >
            <SelectTrigger className="w-[140px]" data-testid="schema-selector">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {availableSchemas.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
          <ErdView
            tables={tables}
            foreignKeys={foreignKeys ?? []}
            viewMode={viewMode}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
