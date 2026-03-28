import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Table2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Badge } from "~/components/ui/badge";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchTables, type TableListItem } from "~/lib/table-data";
import { CreateTableDialog } from "~/components/create-table-dialog";

interface TableListPageProps {
  projectId: string;
  apiKey: string;
  onSelectTable?: (tableName: string) => void;
  isPaused?: boolean;
}

const sensitivityColors: Record<string, string> = {
  plain: "bg-muted text-muted-foreground",
  searchable: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  private: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
};

export function TableListPage({ projectId, apiKey, onSelectTable, isPaused }: TableListPageProps) {
  const [createOpen, setCreateOpen] = React.useState(false);
  const {
    data: tables,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["tables", projectId, apiKey],
    queryFn: () => fetchTables(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="table-list-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {error instanceof Error ? error.message : "Failed to fetch tables"}
        </p>
      </div>
    );
  }

  const newTableButton = (
    <Button
      onClick={() => setCreateOpen(true)}
      disabled={isPaused}
      size="sm"
    >
      <Plus className="h-4 w-4 mr-1" />
      New Table
    </Button>
  );

  const createDialog = (
    <CreateTableDialog
      apiKey={apiKey}
      projectId={projectId}
      open={createOpen}
      onOpenChange={setCreateOpen}
      disabled={isPaused}
    />
  );

  if (!tables || tables.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Tables</h2>
          {newTableButton}
        </div>
        <div className="text-center py-12">
          <Table2 className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
          <p className="text-muted-foreground">
            No tables yet. Create a table using the SDK or API.
          </p>
        </div>
        {createDialog}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Tables</h2>
        {newTableButton}
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {tables.map((table) => (
          <TableCard
            key={table.name}
            table={table}
            onClick={() => onSelectTable?.(table.name)}
          />
        ))}
      </div>
      {createDialog}
    </div>
  );
}

function TableCard({
  table,
  onClick,
}: {
  table: TableListItem;
  onClick?: () => void;
}) {
  const sensitivityCounts = table.columns.reduce(
    (acc, col) => {
      acc[col.sensitivity] = (acc[col.sensitivity] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  return (
    <Card
      className={onClick ? "cursor-pointer hover:border-primary transition-colors" : ""}
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Table2 className="h-4 w-4" />
          {table.name}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground mb-2">
          {table.columns.length} columns
        </p>
        <div className="flex flex-wrap gap-1">
          {Object.entries(sensitivityCounts).map(([sensitivity, count]) => (
            <Badge
              key={sensitivity}
              className={`text-[10px] ${sensitivityColors[sensitivity] ?? ""}`}
            >
              {count} {sensitivity}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
