import { useCallback, useEffect, useRef, useState } from "react";
import type { IMcpSyncService } from "@zcode/services";
import type { NativeMcpServerRecord, ZCodeMcpServer } from "@zcode/shared";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { McpServerForm } from "@/settings/McpServerForm.js";
import { McpServerList } from "@/settings/McpServerList.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { formToConfig, type FormState, type McpEditorMode } from "@/settings/mcpSettingsShared.js";
import { mergeMcpServerStatusSnapshots } from "@/store/mcpStoreStatusList.js";
import { useMcpStore } from "@/store/mcpStore.js";
import {
  mcpProjectionMatchesWorkspace,
  mcpServersForProjectStatusProbe,
  projectMcpConfig,
  projectMcpSaveRequest,
  projectMcpUpsertPlan,
  toProjectMcpServers,
} from "@/WorkspaceSidebar/projectMcpRecords.js";

export function WorkspaceProjectMcpDialog({
  mcpSyncService,
  onOpenChange,
  open,
  workspaceIdentity,
  workspaceLabel,
  workspacePath,
}: {
  mcpSyncService: Pick<
    IMcpSyncService,
    "listWorkspaceMcpServerStatuses" | "loadMcpFromUserDirectory" | "saveMcpToUserDirectory"
  >;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceIdentity?: string;
  workspaceLabel: string;
  workspacePath: string;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [servers, setServers] = useState<ZCodeMcpServer[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [probing, setProbing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingServer, setEditingServer] = useState<ZCodeMcpServer | null>(null);
  const [editorMode, setEditorMode] = useState<McpEditorMode>("form");
  const aliveRef = useRef(true);
  const refreshGenerationRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const stillCurrent = () => aliveRef.current && refreshGenerationRef.current === generation;
    const result = await mcpSyncService.loadMcpFromUserDirectory({ workspacePath });
    if (!stillCurrent()) return null;
    setServers(toProjectMcpServers(result.servers));
    setLoadError(false);
    const state = useMcpStore.getState();
    // 投影属于当前活动工作区。这里编辑的可能是侧栏里另一个工作区，
    // 不能把它的目录读进那份投影。这一步不挡住列表。
    if (
      mcpProjectionMatchesWorkspace(
        {
          projectPath: state.currentProjectPath,
          workspaceIdentity: state.currentWorkspaceIdentity,
        },
        { projectPath: workspacePath, workspaceIdentity },
      )
    ) {
      void state.loadMcpFromUserDirectory(mcpSyncService, workspaceIdentity).catch((error) => {
        logger.warn(
          "[project-mcp] refresh active projection failed",
          error instanceof Error ? error.message : String(error),
        );
      });
    }
    return result.servers;
  }, [mcpSyncService, workspaceIdentity, workspacePath]);

  const probeStatuses = useCallback(
    async (records: readonly NativeMcpServerRecord[]) => {
      const generation = refreshGenerationRef.current;
      const stillCurrent = () => aliveRef.current && refreshGenerationRef.current === generation;
      const probe = mcpServersForProjectStatusProbe(records, workspacePath);
      if (probe.length === 0) return;
      setServers((current) =>
        current.map((server) => (server.enabled ? { ...server, status: "connecting" } : server)),
      );
      try {
        const status = await mcpSyncService.listWorkspaceMcpServerStatuses({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          mcpServers: probe,
        });
        if (!stillCurrent()) return;
        setServers((current) => mergeMcpServerStatusSnapshots(current, status.statuses));
      } catch (error) {
        logger.warn(
          "[project-mcp] status refresh failed",
          error instanceof Error ? error.message : String(error),
        );
        if (!stillCurrent()) return;
        setServers((current) =>
          current.map((server) =>
            server.status === "connecting"
              ? {
                  ...server,
                  status: "error",
                  failureKind: "status_unavailable",
                  error: error instanceof Error ? error.message : String(error),
                }
              : server,
          ),
        );
      }
    },
    [mcpSyncService, workspaceIdentity, workspacePath],
  );

  async function handleRefresh() {
    if (probing) return;
    setProbing(true);
    try {
      const records = await reload();
      if (records) await probeStatuses(records);
    } catch {
      toast(intl.formatMessage({ id: "workspaceSidebar.projectMcp.loadFailed" }));
    } finally {
      if (aliveRef.current) setProbing(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setShowForm(false);
    setEditingServer(null);
    void reload()
      .then(() => {
        if (cancelled) return;
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, reload]);

  function openCreate() {
    setEditingServer(null);
    setEditorMode("form");
    setShowForm(true);
  }

  async function handleSave(form: FormState, prev?: ZCodeMcpServer) {
    const name = form.name.trim();
    if (!name) return;
    try {
      for (const request of projectMcpUpsertPlan({
        previousName: prev?.name,
        nextName: name,
        projectPath: workspacePath,
        config: projectMcpConfig(formToConfig(form), prev?.enabled !== false),
      })) {
        await mcpSyncService.saveMcpToUserDirectory(request);
      }
      toast(intl.formatMessage({ id: "workspaceSidebar.projectMcp.saved" }));
      setShowForm(false);
      setEditingServer(null);
      await reload();
    } catch {
      toast(intl.formatMessage({ id: "workspaceSidebar.projectMcp.saveFailed" }));
    }
  }

  async function handleDelete(server: ZCodeMcpServer) {
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "settings.mcp.deleteConfirmTitle" }, { name: server.name }),
      description: intl.formatMessage({ id: "settings.mcp.deleteConfirmDescription" }),
      confirmLabel: intl.formatMessage({ id: "settings.mcp.deleteConfirmAction" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
    if (!confirmed) return;
    try {
      await mcpSyncService.saveMcpToUserDirectory(
        projectMcpSaveRequest({
          action: "delete",
          name: server.name,
          projectPath: workspacePath,
        }),
      );
      setShowForm(false);
      setEditingServer(null);
      await reload();
    } catch {
      toast(intl.formatMessage({ id: "workspaceSidebar.projectMcp.saveFailed" }));
    }
  }

  async function handleToggle(id: string, enabled: boolean) {
    const server = servers.find((item) => item.id === id);
    if (!server) return;
    try {
      await mcpSyncService.saveMcpToUserDirectory(
        projectMcpSaveRequest({
          action: "set-enabled",
          name: server.name,
          projectPath: workspacePath,
          enabled,
          location: server.location,
        }),
      );
      await reload();
    } catch {
      toast(intl.formatMessage({ id: "workspaceSidebar.projectMcp.saveFailed" }));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-4rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {showForm
              ? intl.formatMessage({
                  id: editingServer
                    ? "settings.mcp.form.editTitle"
                    : "settings.mcp.form.createTitle",
                })
              : intl.formatMessage({ id: "workspaceSidebar.projectMcp" })}
          </DialogTitle>
          <DialogDescription className="break-all">
            {showForm
              ? workspaceLabel
              : intl.formatMessage({ id: "workspaceSidebar.projectMcp.description" })}
          </DialogDescription>
          {!showForm ? (
            <p className="break-all text-ui-sm text-foreground-subtle">{workspaceLabel}</p>
          ) : null}
        </DialogHeader>
        {open && showForm ? (
          <div className="space-y-4">
            <div className="flex justify-end">
              <SettingsSegmentedTabs
                value={editorMode}
                items={[
                  {
                    value: "form",
                    label: intl.formatMessage({ id: "settings.mcp.form.mode.form" }),
                  },
                  { value: "json", label: "JSON" },
                ]}
                onValueChange={setEditorMode}
              />
            </div>
            <McpServerForm
              initial={editingServer ?? undefined}
              editingId={editingServer?.id}
              editorMode={editorMode}
              scopeKey={workspacePath}
              showScope={false}
              workspaceTabs={[]}
              onScopeKeyChange={() => {}}
              onEditorModeChange={setEditorMode}
              onSave={(form, prev) => {
                void handleSave(form, prev);
              }}
              onDelete={editingServer ? (server) => void handleDelete(server) : undefined}
              onCancel={() => {
                setShowForm(false);
                setEditingServer(null);
              }}
            />
          </div>
        ) : null}
        {open && !showForm ? (
          loading ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "common.loading" })}
            </p>
          ) : loadError ? (
            <p className="text-ui-base text-destructive">
              {intl.formatMessage({ id: "workspaceSidebar.projectMcp.loadFailed" })}
            </p>
          ) : (
            <div className="space-y-4">
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={probing}
                  onClick={() => {
                    void handleRefresh();
                  }}
                  className="gap-1.5"
                >
                  <RefreshCw className={probing ? "size-4 animate-spin" : "size-4"} />
                  <span>{intl.formatMessage({ id: "common.refresh" })}</span>
                </Button>
                {servers.length > 0 ? (
                  <Button type="button" variant="outline" size="lg" onClick={openCreate} className="gap-1.5">
                    <Plus className="size-4" />
                    <span>{intl.formatMessage({ id: "settings.mcp.create.open" })}</span>
                  </Button>
                ) : null}
              </div>
              <McpServerList
                hideMetadata
                servers={servers}
                onCreate={openCreate}
                onEdit={(server) => {
                  setEditingServer(server);
                  setEditorMode("form");
                  setShowForm(true);
                }}
                onToggle={(id, enabled) => {
                  void handleToggle(id, enabled);
                }}
                emptyTitle={intl.formatMessage({ id: "settings.mcp.emptyTitle" })}
                emptyDescription={intl.formatMessage({ id: "settings.mcp.emptyDescription" })}
              />
            </div>
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
