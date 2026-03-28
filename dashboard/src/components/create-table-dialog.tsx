import * as React from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { createTable } from "~/lib/table-data";
import {
  validateTableName,
  validateColumns,
  type CreateTableColumn,
} from "~/lib/create-table-validation";

const DATA_TYPES = [
  "text",
  "integer",
  "bigint",
  "boolean",
  "uuid",
  "timestamptz",
  "jsonb",
  "vector",
];

const SENSITIVITIES = ["plain", "searchable", "private"];

function emptyColumn(): CreateTableColumn {
  return { name: "", data_type: "text", sensitivity: "plain", is_owner: false };
}

interface CreateTableDialogProps {
  apiKey: string;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  disabled?: boolean;
}

export function CreateTableDialog({
  apiKey,
  projectId,
  open,
  onOpenChange,
  disabled,
}: CreateTableDialogProps) {
  const queryClient = useQueryClient();
  const [tableName, setTableName] = React.useState("");
  const [columns, setColumns] = React.useState<CreateTableColumn[]>([emptyColumn()]);
  const [validationError, setValidationError] = React.useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => createTable(apiKey, tableName, columns),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tables", projectId, apiKey] });
      onOpenChange(false);
      resetForm();
    },
  });

  function resetForm() {
    setTableName("");
    setColumns([emptyColumn()]);
    setValidationError(null);
    mutation.reset();
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setValidationError(null);

    const nameErr = validateTableName(tableName);
    if (nameErr) {
      setValidationError(nameErr);
      return;
    }

    const colErr = validateColumns(columns);
    if (colErr) {
      setValidationError(colErr);
      return;
    }

    mutation.mutate();
  }

  function addColumn() {
    setColumns([...columns, emptyColumn()]);
  }

  function removeColumn(index: number) {
    setColumns(columns.filter((_, i) => i !== index));
  }

  function updateColumn(index: number, patch: Partial<CreateTableColumn>) {
    setColumns(columns.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) resetForm();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Create Table</DialogTitle>
            <DialogDescription>
              Define a new table with columns and sensitivity levels.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            {/* Table Name */}
            <div className="space-y-2">
              <Label htmlFor="table-name">Table Name</Label>
              <Input
                id="table-name"
                placeholder="my_table"
                value={tableName}
                onChange={(e) => setTableName(e.target.value)}
              />
            </div>

            {/* Columns */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Columns</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addColumn}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Add Column
                </Button>
              </div>

              <div className="space-y-2">
                {columns.map((col, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      placeholder="column_name"
                      value={col.name}
                      onChange={(e) => updateColumn(i, { name: e.target.value })}
                      className="flex-1"
                    />
                    <Select
                      value={col.data_type}
                      onValueChange={(v) => updateColumn(i, { data_type: v ?? "text" })}
                    >
                      <SelectTrigger aria-label={`Data type for column ${i + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DATA_TYPES.map((dt) => (
                          <SelectItem key={dt} value={dt}>
                            {dt}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select
                      value={col.sensitivity}
                      onValueChange={(v) => updateColumn(i, { sensitivity: v ?? "plain" })}
                    >
                      <SelectTrigger aria-label={`Sensitivity for column ${i + 1}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {SENSITIVITIES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-1" title="Owner column">
                      <Switch
                        checked={col.is_owner}
                        onCheckedChange={(v) =>
                          updateColumn(i, { is_owner: !!v })
                        }
                        aria-label={`Owner toggle for column ${i + 1}`}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeColumn(i)}
                      aria-label="Remove column"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            {/* Validation / API error */}
            {(validationError || mutation.error) && (
              <p className="text-sm text-destructive" role="alert">
                {validationError ??
                  (mutation.error instanceof Error
                    ? mutation.error.message
                    : "An error occurred")}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={disabled || mutation.isPending}
            >
              {mutation.isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
