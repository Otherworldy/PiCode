import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IMemoryService,
  ProjectMemoryFileSummary,
  ProjectMemoryWorkspaceSummary,
} from "@picode/services";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { TID_WORKSPACE_MEMORY_DELETE_CONFIRM } from "@picode/shared";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeSessionService } from "@/hooks/usePiCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import {
  isValidWorkspaceMemoryFileName,
  WorkspaceMemoryEditor,
  type WorkspaceMemoryEditorState,
} from "./WorkspaceMemoryEditor.js";
import { fromWorkspaceMemoryModelValue } from "./WorkspaceMemoryModelSelect.js";
import { WorkspaceMemorySettingsRows } from "./WorkspaceMemorySettingsRows.js";
import { useWorkspaceMemoryConfig } from "./useWorkspaceMemoryConfig.js";
import { useWorkspaceMemoryModelOptions } from "./useWorkspaceMemoryModelOptions.js";

type WorkspaceMemoryService = Pick<
  IMemoryService,
  | "listProjectMemories"
  | "readProjectMemoryFile"
  | "writeProjectMemoryFile"
  | "deleteProjectMemoryFile"
  | "getWorkspaceMemoryEnabled"
  | "setWorkspaceMemoryEnabled"
  | "getWorkspaceMemoryModel"
  | "setWorkspaceMemoryModel"
  | "getWorkspaceMemoryExpiryDays"
  | "setWorkspaceMemoryExpiryDays"
>;

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function WorkspaceMemoryDialog({
  memoryService,
  onOpenChange,
  open,
  remote = false,
  workspaceIdentity,
  workspaceLabel,
  workspacePath,
}: {
  memoryService: WorkspaceMemoryService;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  /** 远端工作区不支持项目记忆，只展示禁用说明。 */
  remote?: boolean;
  workspaceIdentity?: string;
  workspaceLabel: string;
  workspacePath: string;
}) {
  const { intl } = useZCodeIntl();
  const session = useZCodeSessionService(workspacePath, null, workspaceIdentity ?? null);
  const requestIdRef = useRef(0);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  /** 文件读写/删除的失败提示；配置项的失败由 hook 各自维护。 */
  const [actionError, setActionError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProjectMemoryWorkspaceSummary | undefined>(undefined);
  const [editor, setEditor] = useState<WorkspaceMemoryEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);

  const workspaceRef = useMemo(
    () => ({ workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }),
    [workspaceIdentity, workspacePath],
  );

  const requestConfirmation = useConfirmDialog();
  const config = useWorkspaceMemoryConfig({ memoryService, open, remote, workspaceRef });

  const editorDirty = editor
    ? editor.isNew
      ? editor.content.length > 0 || editor.fileName.length > 0
      : editor.content !== editor.originalContent
    : false;

  /** 只刷新文件列表；三项项目级配置由 useWorkspaceMemoryConfig 自己维护。 */
  const refreshCatalog = useCallback(async () => {
    if (remote) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const result = await memoryService.listProjectMemories({ workspaces: [workspaceRef] });
      if (requestIdRef.current !== requestId) return;
      setSummary(result[0]);
      setCatalogState("ready");
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setSummary(undefined);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
    }
  }, [memoryService, remote, workspaceRef]);

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1;
      setCatalogState("idle");
      setSummary(undefined);
      setActionError(null);
      setEditor(null);
      setEditorError(null);
      return;
    }
    if (remote) {
      setCatalogState("idle");
      return;
    }
    void refreshCatalog();
  }, [open, refreshCatalog, remote]);

  const modelOptions = useWorkspaceMemoryModelOptions({
    open,
    remote,
    session,
    workspaceIdentity,
    workspacePath,
  });

  const handleMemoryEnabledChange = useCallback(
    async (next: boolean) => {
      await config.setEnabled(next);
      await refreshCatalog();
    },
    [config, refreshCatalog],
  );

  const handleModelChange = useCallback(
    (value: string) => {
      void config.setModel(fromWorkspaceMemoryModelValue(value));
    },
    [config],
  );

  const handleExpiryDaysChange = useCallback(
    (days: number) => {
      void config.setExpiryDays(days);
    },
    [config],
  );

  const openExistingFile = useCallback(
    async (file: ProjectMemoryFileSummary) => {
      if (file.missing) {
        setEditorError(null);
        setEditor({
          fileName: file.name,
          originalFileName: file.name,
          content: "",
          originalContent: "",
          isNew: false,
        });
        return;
      }
      try {
        const { content } = await memoryService.readProjectMemoryFile({
          ...workspaceRef,
          fileName: file.name,
        });
        setEditorError(null);
        setEditor({
          fileName: file.name,
          originalFileName: file.name,
          content,
          originalContent: content,
          isNew: false,
        });
      } catch (error) {
        setActionError(getErrorMessage(error));
      }
    },
    [memoryService, workspaceRef],
  );

  const openNewFile = useCallback(() => {
    setEditorError(null);
    setEditor({
      fileName: "",
      originalFileName: "",
      content: "",
      originalContent: "",
      isNew: true,
    });
  }, []);

  const closeEditor = useCallback(() => {
    setEditor(null);
    setEditorError(null);
  }, []);

  const requestDiscard = useCallback(
    async (action: "close" | "cancel") => {
      if (editorDirty) {
        // 丢弃草稿不可撤销，走全站统一的危险色确认框。
        const confirmed = await requestConfirmation({
          title: intl.formatMessage({ id: "settings.memory.viewer.discardTitle" }),
          description: intl.formatMessage({ id: "settings.memory.viewer.discardDescription" }),
          confirmLabel: intl.formatMessage({ id: "settings.memory.viewer.discard" }),
          cancelLabel: intl.formatMessage({ id: "settings.memory.viewer.keepEditing" }),
          confirmVariant: "destructive",
        });
        if (!confirmed) return;
      }
      if (action === "close") {
        closeEditor();
        onOpenChange(false);
        return;
      }
      closeEditor();
    },
    [closeEditor, editorDirty, intl, onOpenChange, requestConfirmation],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true);
        return;
      }
      void requestDiscard("close");
    },
    [onOpenChange, requestDiscard],
  );

  const saveEditor = useCallback(async () => {
    if (!editor) return;
    const fileName = editor.isNew ? editor.fileName.trim() : editor.fileName;
    if (!isValidWorkspaceMemoryFileName(fileName)) {
      setEditorError(intl.formatMessage({ id: "settings.memory.viewer.invalidFileName" }));
      return;
    }
    if (editor.isNew && summary?.files.some((file) => file.name === fileName)) {
      setEditorError(intl.formatMessage({ id: "settings.memory.viewer.fileExists" }));
      return;
    }
    setEditorSaving(true);
    setEditorError(null);
    try {
      await memoryService.writeProjectMemoryFile({
        ...workspaceRef,
        fileName,
        content: editor.content,
      });
      setEditor(null);
      await refreshCatalog();
    } catch (error) {
      setEditorError(getErrorMessage(error));
    } finally {
      setEditorSaving(false);
    }
  }, [editor, intl, memoryService, refreshCatalog, summary, workspaceRef]);

  const requestDelete = useCallback(
    async (file: ProjectMemoryFileSummary) => {
      // 删除记忆文件不可恢复，走全站统一的危险色确认框。
      const confirmed = await requestConfirmation({
        testId: TID_WORKSPACE_MEMORY_DELETE_CONFIRM,
        title: intl.formatMessage({ id: "settings.memory.viewer.deleteTitle" }),
        description: intl.formatMessage(
          { id: "settings.memory.viewer.deleteDescription" },
          { name: file.name },
        ),
        confirmLabel: intl.formatMessage({ id: "settings.memory.viewer.deleteConfirm" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      try {
        await memoryService.deleteProjectMemoryFile({
          ...workspaceRef,
          fileName: file.name,
        });
        setActionError(null);
        await refreshCatalog();
      } catch (error) {
        setActionError(getErrorMessage(error));
      }
    },
    [intl, memoryService, refreshCatalog, requestConfirmation, workspaceRef],
  );

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent
        className={`flex max-h-[calc(100vh-4rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0${editor ? " h-[min(40rem,calc(100vh-4rem))]" : ""}`}
      >
        <DialogHeader className="gap-1 border-b border-border px-4 py-3 pr-12">
          <div className="flex min-w-0 items-center gap-3">
            <DialogTitle>{intl.formatMessage({ id: "workspaceSidebar.memory" })}</DialogTitle>
            <DialogDescription className="truncate font-mono text-ui-sm">
              {editor ? editor.fileName || "—" : workspaceLabel}
            </DialogDescription>
          </div>
        </DialogHeader>

        {editor ? (
          <WorkspaceMemoryEditor
            editor={editor}
            error={editorError}
            saving={editorSaving}
            onCancel={() => {
              void requestDiscard("cancel");
            }}
            onChange={(patch) => {
              setEditor((current) => (current ? { ...current, ...patch } : current));
            }}
            onSave={() => {
              void saveEditor();
            }}
          />
        ) : (
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
            <WorkspaceMemorySettingsRows
              disabled={remote || config.enabledLoading}
              enabled={config.enabled}
              expiryDays={config.expiryDays}
              memoryModel={config.memoryModel}
              modelOptions={modelOptions}
              onEnabledChange={(checked) => {
                void handleMemoryEnabledChange(checked);
              }}
              onExpiryDaysChange={(days) => {
                void handleExpiryDaysChange(days);
              }}
              onModelChange={(value) => {
                void handleModelChange(value);
              }}
            />

            {[config.switchError, config.modelError, config.expiryError, actionError]
              .filter((message): message is string => Boolean(message))
              .map((message) => (
                <Alert key={message}>
                  <AlertDescription>{message}</AlertDescription>
                </Alert>
              ))}

            {remote ? (
              <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.memory.viewer.remoteUnsupported" })}
              </div>
            ) : (
              <MemorySettingsViewer
                catalogError={catalogError}
                catalogState={catalogState}
                selectedWorkspace={summary}
                workspaces={summary ? [summary] : []}
                onCreateFile={openNewFile}
                onDeleteFile={(file) => {
                  void requestDelete(file);
                }}
                onEditFile={(file) => {
                  void openExistingFile(file);
                }}
                onRefresh={refreshCatalog}
                onScopeKeyChange={() => {}}
                showScopeSelector={false}
              />
            )}
          </div>
        )}

        {editor ? null : (
          <DialogFooter className="border-t border-border px-4 py-3 sm:justify-end">
            <Button
              onClick={() => handleOpenChange(false)}
              size="lg"
              type="button"
              variant="outline"
            >
              {intl.formatMessage({ id: "common.close" })}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
