import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  IMemoryService,
  ProjectMemoryFileSummary,
  ProjectMemoryWorkspaceSummary,
  WorkspaceMemoryModelRef,
} from "@zcode/services";
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
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import {
  WorkspaceMemoryDeleteDialog,
  WorkspaceMemoryDiscardDialog,
} from "./WorkspaceMemoryConfirmDialogs.js";
import {
  isValidWorkspaceMemoryFileName,
  WorkspaceMemoryEditor,
  type WorkspaceMemoryEditorState,
} from "./WorkspaceMemoryEditor.js";
import { fromWorkspaceMemoryModelValue } from "./WorkspaceMemoryModelSelect.js";
import { WorkspaceMemorySettingsRows } from "./WorkspaceMemorySettingsRows.js";
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
  const [enabled, setEnabled] = useState(false);
  const [enabledLoading, setEnabledLoading] = useState(true);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [memoryModel, setMemoryModel] = useState<WorkspaceMemoryModelRef | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ProjectMemoryWorkspaceSummary | undefined>(undefined);
  const [editor, setEditor] = useState<WorkspaceMemoryEditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProjectMemoryFileSummary | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [discardAction, setDiscardAction] = useState<"close" | "cancel">("cancel");

  const workspaceRef = useMemo(
    () => ({ workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }),
    [workspaceIdentity, workspacePath],
  );

  const editorDirty = editor
    ? editor.isNew
      ? editor.content.length > 0 || editor.fileName.length > 0
      : editor.content !== editor.originalContent
    : false;

  const refresh = useCallback(async () => {
    if (remote) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const [nextEnabled, nextModel, result] = await Promise.all([
        memoryService.getWorkspaceMemoryEnabled(workspaceRef),
        memoryService.getWorkspaceMemoryModel(workspaceRef).catch(() => null),
        memoryService.listProjectMemories({ workspaces: [workspaceRef] }),
      ]);
      if (requestIdRef.current !== requestId) return;
      setEnabled(nextEnabled);
      setMemoryModel(nextModel);
      setSummary(result[0]);
      setCatalogState("ready");
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setSummary(undefined);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
    } finally {
      if (requestIdRef.current === requestId) setEnabledLoading(false);
    }
  }, [memoryService, remote, workspaceRef]);

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1;
      setCatalogState("idle");
      setSummary(undefined);
      setSwitchError(null);
      setModelError(null);
      setEditor(null);
      setEditorError(null);
      setDeleteTarget(null);
      setDiscardOpen(false);
      return;
    }
    if (remote) {
      setEnabledLoading(false);
      setCatalogState("idle");
      return;
    }
    setEnabledLoading(true);
    void refresh();
  }, [open, remote, refresh]);

  const modelOptions = useWorkspaceMemoryModelOptions({
    open,
    remote,
    session,
    workspaceIdentity,
    workspacePath,
  });

  const handleMemoryEnabledChange = useCallback(
    async (next: boolean) => {
      if (remote) return;
      const previous = enabled;
      setEnabled(next);
      setSwitchError(null);
      try {
        await memoryService.setWorkspaceMemoryEnabled({ ...workspaceRef, enabled: next });
        await refresh();
      } catch (error) {
        setEnabled(previous);
        setSwitchError(getErrorMessage(error));
      }
    },
    [enabled, memoryService, refresh, remote, workspaceRef],
  );

  const handleModelChange = useCallback(
    async (value: string) => {
      if (remote) return;
      const next = fromWorkspaceMemoryModelValue(value);
      const previous = memoryModel;
      setMemoryModel(next);
      setModelError(null);
      try {
        await memoryService.setWorkspaceMemoryModel({ ...workspaceRef, model: next });
      } catch (error) {
        setMemoryModel(previous);
        setModelError(getErrorMessage(error));
      }
    },
    [memoryModel, memoryService, remote, workspaceRef],
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
        setSwitchError(getErrorMessage(error));
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
    (action: "close" | "cancel") => {
      if (!editorDirty) {
        if (action === "close") onOpenChange(false);
        else closeEditor();
        return;
      }
      setDiscardAction(action);
      setDiscardOpen(true);
    },
    [closeEditor, editorDirty, onOpenChange],
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        onOpenChange(true);
        return;
      }
      requestDiscard("close");
    },
    [onOpenChange, requestDiscard],
  );

  const confirmDiscard = useCallback(() => {
    setDiscardOpen(false);
    if (discardAction === "close") {
      closeEditor();
      onOpenChange(false);
      return;
    }
    closeEditor();
  }, [closeEditor, discardAction, onOpenChange]);

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
      await refresh();
    } catch (error) {
      setEditorError(getErrorMessage(error));
    } finally {
      setEditorSaving(false);
    }
  }, [editor, intl, memoryService, refresh, summary, workspaceRef]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    try {
      await memoryService.deleteProjectMemoryFile({
        ...workspaceRef,
        fileName: deleteTarget.name,
      });
      setDeleteTarget(null);
      setSwitchError(null);
      await refresh();
    } catch (error) {
      setDeleteTarget(null);
      setSwitchError(getErrorMessage(error));
    }
  }, [deleteTarget, memoryService, refresh, workspaceRef]);

  return (
    <>
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
              onCancel={() => requestDiscard("cancel")}
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
                disabled={remote || enabledLoading}
                enabled={enabled}
                memoryModel={memoryModel}
                modelOptions={modelOptions}
                onEnabledChange={(checked) => {
                  void handleMemoryEnabledChange(checked);
                }}
                onModelChange={(value) => {
                  void handleModelChange(value);
                }}
              />

              {switchError ? (
                <Alert>
                  <AlertDescription>{switchError}</AlertDescription>
                </Alert>
              ) : null}
              {modelError ? (
                <Alert>
                  <AlertDescription>{modelError}</AlertDescription>
                </Alert>
              ) : null}

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
                  onDeleteFile={setDeleteTarget}
                  onEditFile={(file) => {
                    void openExistingFile(file);
                  }}
                  onRefresh={refresh}
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

      <WorkspaceMemoryDiscardDialog
        open={discardOpen}
        onDiscard={confirmDiscard}
        onOpenChange={setDiscardOpen}
      />

      <WorkspaceMemoryDeleteDialog
        fileName={deleteTarget?.name ?? null}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          void confirmDelete();
        }}
      />
    </>
  );
}
