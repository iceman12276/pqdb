import * as React from "react";
import { getTokens } from "~/lib/auth-store";
import { useNavigate } from "~/lib/navigation";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();
  const tokens = getTokens();

  React.useEffect(() => {
    if (!tokens) {
      navigate({ to: "/login" });
    }
  }, [tokens, navigate]);

  if (!tokens) {
    return null;
  }

  return <>{children}</>;
}
