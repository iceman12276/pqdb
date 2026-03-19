import * as React from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { KeyRound } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import type { IntrospectionColumn } from "~/lib/schema";

export interface TableNodeData {
  label: string;
  columns: IntrospectionColumn[];
  viewMode: "logical" | "physical";
  [key: string]: unknown;
}

const sensitivityColors: Record<string, string> = {
  plain: "bg-muted text-muted-foreground",
  searchable: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  private: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
};

function getDisplayColumns(
  columns: IntrospectionColumn[],
  viewMode: "logical" | "physical",
): { name: string; type: string; sensitivity: string; is_owner: boolean }[] {
  if (viewMode === "logical") {
    return columns.map((col) => ({
      name: col.name,
      type: col.type,
      sensitivity: col.sensitivity,
      is_owner: col.is_owner,
    }));
  }

  // Physical view: expand shadow columns
  const result: { name: string; type: string; sensitivity: string; is_owner: boolean }[] = [];
  for (const col of columns) {
    if (col.sensitivity === "searchable") {
      result.push({ name: `${col.name}_encrypted`, type: "bytea", sensitivity: col.sensitivity, is_owner: col.is_owner });
      result.push({ name: `${col.name}_index`, type: "text", sensitivity: col.sensitivity, is_owner: false });
    } else if (col.sensitivity === "private") {
      result.push({ name: `${col.name}_encrypted`, type: "bytea", sensitivity: col.sensitivity, is_owner: col.is_owner });
    } else {
      result.push({ name: col.name, type: col.type, sensitivity: col.sensitivity, is_owner: col.is_owner });
    }
  }
  return result;
}

export function ErdTableNode({ data }: NodeProps) {
  const { label, columns, viewMode } = data as TableNodeData;
  const displayColumns = getDisplayColumns(columns, viewMode);

  return (
    <div
      data-testid={`erd-table-${label}`}
      className="rounded-lg border border-border bg-card shadow-md min-w-[220px]"
    >
      <Handle type="target" position={Position.Left} className="!bg-primary" />
      <div className="rounded-t-lg border-b border-border bg-muted px-3 py-2">
        <span className="text-sm font-semibold">{label}</span>
      </div>
      <div className="divide-y divide-border">
        {displayColumns.map((col, idx) => (
          <div
            key={`${col.name}-${idx}`}
            className="flex items-center gap-2 px-3 py-1.5 text-xs"
          >
            {col.is_owner && (
              <KeyRound
                className="h-3 w-3 text-amber-500 shrink-0"
                data-testid="owner-icon"
              />
            )}
            <span className="font-mono flex-1 truncate">{col.name}</span>
            <span className="text-muted-foreground">{col.type}</span>
            <Badge
              data-testid={`badge-${col.sensitivity}`}
              className={`text-[10px] px-1.5 py-0 h-4 ${sensitivityColors[col.sensitivity] ?? ""}`}
            >
              {col.sensitivity}
            </Badge>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-primary" />
    </div>
  );
}
