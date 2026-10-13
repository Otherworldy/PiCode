import type { MobileRemoteWorkspaceListItem } from "@zcode/shared";

function copy(zh: string, en: string): string {
  return /^zh\b/i.test(navigator.language) ? zh : en;
}

export function MobileRemoteWorkspacePicker({
  workspaces,
  message,
  onSelect,
}: {
  workspaces: MobileRemoteWorkspaceListItem[];
  message?: string;
  onSelect: (workspace: MobileRemoteWorkspaceListItem) => void;
}) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg flex-col justify-center gap-4 px-4">
        <h1 className="text-ui-base font-medium">{copy("选择工作区", "Choose a workspace")}</h1>
        {message ? <p className="text-ui-sm text-foreground-subtle">{message}</p> : null}
        {workspaces.length === 0 ? (
          <p className="text-ui-sm text-foreground-subtle">
            {copy("这个窗口还没有打开的工作区。", "This window has no open workspace.")}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {workspaces.map((workspace) => (
              <button
                key={workspace.workspaceKey}
                type="button"
                className="rounded-xl border border-card-border bg-card px-4 py-3 text-left"
                onClick={() => onSelect(workspace)}
              >
                <span className="block text-ui-sm">{workspace.label}</span>
                <span className="block break-all text-ui-xs text-foreground-subtle">
                  {workspace.kind === "remote" ? copy("远端", "Remote") : copy("本地", "Local")}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export async function loadMobileRemoteWorkspaces(): Promise<MobileRemoteWorkspaceListItem[]> {
  const response = await fetch("/api/mobile-remote/workspaces", { cache: "no-store" });
  if (response.status === 401) {
    throw new Error(copy("配对已断开。", "The pairing has ended."));
  }
  if (!response.ok) {
    throw new Error(copy("没能读取工作区。", "Could not load workspaces."));
  }
  const body = (await response.json()) as { workspaces?: MobileRemoteWorkspaceListItem[] };
  return Array.isArray(body.workspaces) ? body.workspaces : [];
}
