/**
 * QueryBuilder — form for building a select query visually.
 *
 * Lets users pick a table, choose columns, add filter rows,
 * and set limit/offset/order modifiers.
 */

import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
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
import type { IntrospectionTable } from "~/lib/schema";
import type { QueryFilter } from "~/lib/query";

const OPERATORS = [
  { value: "eq", label: "= (equals)" },
  { value: "gt", label: "> (greater than)" },
  { value: "lt", label: "< (less than)" },
  { value: "gte", label: ">= (gte)" },
  { value: "lte", label: "<= (lte)" },
  { value: "in", label: "IN (list)" },
] as const;

export interface QueryBuilderState {
  table: string;
  columns: string[];
  filters: QueryFilter[];
  limit: string;
  offset: string;
  orderBy: string;
  orderDir: string;
}

interface QueryBuilderProps {
  tables: IntrospectionTable[];
  state: QueryBuilderState;
  onChange: (state: QueryBuilderState) => void;
  onExecute: () => void;
  isExecuting: boolean;
}

export function QueryBuilder({
  tables,
  state,
  onChange,
  onExecute,
  isExecuting,
}: QueryBuilderProps) {
  const selectedTable = tables.find((t) => t.name === state.table);
  const queryableColumns = selectedTable
    ? selectedTable.columns.filter((c) => c.queryable)
    : [];

  function setTable(name: string | null) {
    if (!name) return;
    onChange({
      ...state,
      table: name,
      columns: [],
      filters: [],
      orderBy: "",
      orderDir: "asc",
    });
  }

  function toggleColumn(col: string) {
    const next = state.columns.includes(col)
      ? state.columns.filter((c) => c !== col)
      : [...state.columns, col];
    onChange({ ...state, columns: next });
  }

  function addFilter() {
    const firstCol = queryableColumns[0]?.name ?? "";
    onChange({
      ...state,
      filters: [...state.filters, { column: firstCol, op: "eq", value: "" }],
    });
  }

  function updateFilter(idx: number, patch: Partial<QueryFilter>) {
    const next = state.filters.map((f, i) =>
      i === idx ? { ...f, ...patch } : f,
    );
    onChange({ ...state, filters: next });
  }

  function removeFilter(idx: number) {
    onChange({ ...state, filters: state.filters.filter((_, i) => i !== idx) });
  }

  return (
    <div className="space-y-4">
      {/* Table selector */}
      <div className="space-y-1.5">
        <Label>Table</Label>
        <div data-testid="table-selector">
          <Select value={state.table} onValueChange={setTable}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Select a table..." />
            </SelectTrigger>
            <SelectContent>
              {tables.map((t) => (
                <SelectItem key={t.name} value={t.name}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Column picker */}
      {selectedTable && (
        <div className="space-y-1.5">
          <Label>Columns</Label>
          <div className="flex flex-wrap gap-2" data-testid="column-picker">
            {selectedTable.columns.map((col) => (
              <button
                key={col.name}
                type="button"
                onClick={() => toggleColumn(col.name)}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                  state.columns.includes(col.name)
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:border-primary/50"
                }`}
                data-testid={`column-toggle-${col.name}`}
              >
                {col.name}
                {col.sensitivity !== "plain" && (
                  <span className="ml-1 opacity-60">
                    ({col.sensitivity === "searchable" ? "enc" : "priv"})
                  </span>
                )}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {state.columns.length === 0
              ? "All columns selected (SELECT *)"
              : `${state.columns.length} column(s) selected`}
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label>Filters</Label>
          <Button
            variant="outline"
            size="sm"
            onClick={addFilter}
            disabled={!state.table || queryableColumns.length === 0}
          >
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add Filter
          </Button>
        </div>
        {state.filters.length === 0 && (
          <p className="text-xs text-muted-foreground">No filters applied</p>
        )}
        <div className="space-y-2">
          {state.filters.map((filter, idx) => (
            <div
              key={idx}
              className="flex items-center gap-2"
              data-testid={`filter-row-${idx}`}
            >
              <Select
                value={filter.column}
                onValueChange={(v) => {
                  if (v) updateFilter(idx, { column: v });
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {queryableColumns.map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={filter.op}
                onValueChange={(v) => {
                  if (v) updateFilter(idx, { op: v });
                }}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPERATORS.map((op) => (
                    <SelectItem key={op.value} value={op.value}>
                      {op.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Input
                value={filter.value}
                onChange={(e) =>
                  updateFilter(idx, { value: e.target.value })
                }
                placeholder="Value..."
                className="flex-1"
              />

              <Button
                variant="outline"
                size="sm"
                onClick={() => removeFilter(idx)}
                aria-label={`Remove filter ${idx}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      {/* Modifiers: limit, offset, order */}
      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="limit">Limit</Label>
          <Input
            id="limit"
            data-testid="limit-input"
            type="number"
            min={0}
            value={state.limit}
            onChange={(e) => onChange({ ...state, limit: e.target.value })}
            placeholder="100"
            className="w-24"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="offset">Offset</Label>
          <Input
            id="offset"
            data-testid="offset-input"
            type="number"
            min={0}
            value={state.offset}
            onChange={(e) => onChange({ ...state, offset: e.target.value })}
            placeholder="0"
            className="w-24"
          />
        </div>
        {selectedTable && (
          <>
            <div className="space-y-1.5">
              <Label>Order By</Label>
              <Select
                value={state.orderBy}
                onValueChange={(v) => onChange({ ...state, orderBy: v ?? "" })}
              >
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  {selectedTable.columns.map((c) => (
                    <SelectItem key={c.name} value={c.name}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Direction</Label>
              <Select
                value={state.orderDir}
                onValueChange={(v) => onChange({ ...state, orderDir: v ?? "asc" })}
              >
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="asc">ASC</SelectItem>
                  <SelectItem value="desc">DESC</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}
      </div>

      {/* Execute */}
      <Button
        onClick={onExecute}
        disabled={!state.table || isExecuting}
        data-testid="execute-button"
      >
        {isExecuting ? "Executing..." : "Execute"}
      </Button>
    </div>
  );
}
