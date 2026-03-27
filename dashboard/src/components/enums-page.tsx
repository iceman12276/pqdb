import { useQuery } from "@tanstack/react-query";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { fetchEnums } from "~/lib/introspection";

interface EnumsPageProps {
  projectId: string;
  apiKey: string;
}

export function EnumsPage({ projectId, apiKey }: EnumsPageProps) {
  const {
    data: enums,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["enums", projectId, apiKey],
    queryFn: () => fetchEnums(apiKey),
    enabled: !!apiKey,
  });

  if (isLoading) {
    return (
      <div data-testid="enums-loading" className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">
          {error instanceof Error ? error.message : "Failed to fetch enums"}
        </p>
      </div>
    );
  }

  if (!enums || enums.length === 0) {
    return (
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">Enums</h2>
        <div className="text-center py-12">
          <p className="text-muted-foreground">
            No enum types found. Create an enum type in your database to see it here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Enums</h2>
      <div className="space-y-4">
        {enums.map((enumType) => (
          <Card key={`${enumType.schema}.${enumType.name}`}>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="font-mono">{enumType.name}</CardTitle>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{enumType.schema}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {enumType.values.length} values
                  </span>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {enumType.values.map((value) => (
                  <Badge key={value} variant="secondary">
                    {value}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
