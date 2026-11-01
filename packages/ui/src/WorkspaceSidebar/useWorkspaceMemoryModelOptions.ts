import { useEffect, useState } from "react";

export interface WorkspaceMemoryModelOption {
  value: string;
  label: string;
}

interface WorkspaceMemoryModelOptionsSession {
  mutatePiModels(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    action: "get";
  }): Promise<{
    providers: Array<{
      id: string;
      name: string;
      models: Array<{ id: string; name: string }>;
    }>;
  }>;
}

export function useWorkspaceMemoryModelOptions({
  open,
  remote,
  session,
  workspaceIdentity,
  workspacePath,
}: {
  open: boolean;
  remote: boolean;
  session: WorkspaceMemoryModelOptionsSession;
  workspaceIdentity?: string;
  workspacePath: string;
}): WorkspaceMemoryModelOption[] {
  const [options, setOptions] = useState<WorkspaceMemoryModelOption[]>([]);
  useEffect(() => {
    if (!open || remote) return;
    let cancelled = false;
    void session
      .mutatePiModels({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        action: "get",
      })
      .then((view) => {
        if (cancelled) return;
        setOptions(
          view.providers.flatMap((provider) =>
            provider.models.map((model) => ({
              value: `${provider.id}::${model.id}`,
              label: `${provider.name} · ${model.name}`,
            })),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) setOptions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, remote, session, workspaceIdentity, workspacePath]);
  return options;
}
