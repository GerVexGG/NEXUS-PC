import { createContext, useContext, useLayoutEffect, useState } from "react";

// Stores presentation choices for this window's session, independent of mounted views.
export const WorkspaceSession = createContext<Map<string, unknown> | null>(null);

export function useWorkspaceState<T>(key: string, initialValue: T) {
  const session = useContext(WorkspaceSession);
  const [value, setValue] = useState<T>(() => session?.has(key) ? session.get(key) as T : initialValue);

  useLayoutEffect(() => {
    session?.set(key, value);
  }, [session, key, value]);

  return [value, setValue] as const;
}
