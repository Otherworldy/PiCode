import { Fragment, useEffect, useMemo, useState } from "react";
import type { ProjectMemoryFileSummary, ProjectMemoryWorkspaceSummary } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_REFRESH,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_WORKSPACE,
  TID_WORKSPACE_MEMORY_CREATE,
  TID_WORKSPACE_MEMORY_DELETE,
  testId,
} from "@zcode/shared";
import { Trash2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";

export type MemoryViewerLoadingState = "idle" | "loading" | "ready" | "error";

export function MemorySettingsViewer({
  catalogError,
  catalogState,
  selectedWorkspace,
  workspaces,
  onRefresh,
  onScopeKeyChange,
  showScopeSelector = true,
  onCreateFile,
  onEditFile,
  onDeleteFile,
}: {
  catalogError: string | null;
  catalogState: MemoryViewerLoadingState;
  selectedWorkspace: ProjectMemoryWorkspaceSummary | undefined;
  workspaces: ProjectMemoryWorkspaceSummary[];
  onRefresh: () => Promise<void>;
  onScopeKeyChange: (workspaceId: string) => void;
  /** 项目对话框只展示一个工作区时，隐藏无意义的作用域切换。 */
  showScopeSelector?: boolean;
  onCreateFile?: () => void;
  onEditFile?: (file: ProjectMemoryFileSummary) => void;
  onDeleteFile?: (file: ProjectMemoryFileSummary) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [searchQuery, setSearchQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const formatMemoryCount = (count: number) =>
    intl.formatMessage(
      {
        id: `settings.memory.viewer.memoryCount.${count === 1 ? "one" : "other"}`,
      },
      { count },
    );
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      selectedWorkspace?.files.filter((file) =>
        file.name.toLocaleLowerCase().includes(normalizedSearchQuery),
      ) ?? [],
    [normalizedSearchQuery, selectedWorkspace],
  );

  if (catalogError) {
    return (
      <Alert>
        <AlertDescription>{catalogError}</AlertDescription>
      </Alert>
    );
  }

  if (catalogState === "loading" && workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.loading" })}
      </div>
    );
  }

  if (!selectedWorkspace) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.empty" })}
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {showScopeSelector ? (
            <>
              <PluginScopeMenu
                includeUser={false}
                selectedScopeKey={selectedWorkspace.id}
                workspaceOptions={workspaces.map((workspace) => ({
                  key: workspace.id,
                  label: workspace.label,
                }))}
                onScopeKeyChange={onScopeKeyChange}
                triggerIconTestId={TID_SETTINGS_MEMORY_SCOPE_ICON}
                triggerTestId={TID_SETTINGS_MEMORY_SCOPE_TRIGGER}
                workspaceOptionTestIdPrefix={TID_SETTINGS_MEMORY_WORKSPACE}
              />
              <div className="h-4 w-px bg-border" aria-hidden="true" />
            </>
          ) : null}
          <span
            data-testid={TID_SETTINGS_MEMORY_COUNT}
            className="shrink-0 text-ui-sm text-foreground-subtle"
          >
            {formatMemoryCount(selectedWorkspace.files.length)}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <SettingsSearchInput
            containerClassName="w-full sm:w-64"
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            clearTestId={TID_SETTINGS_MEMORY_SEARCH_CLEAR}
            data-testid={TID_SETTINGS_MEMORY_SEARCH_INPUT}
            value={searchQuery}
            onClear={() => setSearchQuery("")}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.memory.viewer.searchPlaceholder",
            })}
          />
        </div>
      </div>

      {normalizedSearchQuery && visibleFiles.length === 0 ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.memory.viewer.searchEmpty",
          })}
        />
      ) : (
        <>
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.memory.viewer.files" })}
            </h3>
            <SettingsResourceHeaderActions
              onRefresh={() => void onRefresh()}
              onNew={onCreateFile}
              refreshing={catalogState === "loading"}
              refreshTestId={TID_SETTINGS_MEMORY_REFRESH}
              refreshLabel={intl.formatMessage({
                id: "settings.memory.viewer.refresh",
              })}
              newLabel={intl.formatMessage({
                id: "settings.memory.viewer.create",
              })}
              newTestId={TID_WORKSPACE_MEMORY_CREATE}
            />
          </div>
          <div className="max-h-[26rem] overflow-y-auto rounded-xl bg-surface">
            {visibleFiles.map((file, index) => (
              <Fragment key={file.name}>
                {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                <div className="flex min-w-0 items-center hover:bg-hover">
                  <div
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE, file.name)}
                    className={`flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left${onEditFile ? " cursor-pointer" : ""}`}
                    role={onEditFile ? "button" : undefined}
                    tabIndex={onEditFile ? 0 : undefined}
                    onClick={onEditFile ? () => onEditFile(file) : undefined}
                    onKeyDown={
                      onEditFile
                        ? (event) => {
                            if (event.key !== "Enter" && event.key !== " ") return;
                            event.preventDefault();
                            onEditFile(file);
                          }
                        : undefined
                    }
                  >
                    <span
                      data-testid={testId(TID_SETTINGS_MEMORY_FILE_ICON, file.name)}
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background"
                    >
                      <FileDisplayIcon
                        src={resolveFileDisplayDescriptor(file.path).fileIconSrc}
                        size={16}
                        className="size-4 shrink-0"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          data-testid={testId(TID_SETTINGS_MEMORY_FILE_NAME, file.name)}
                          className="truncate text-ui-base font-medium text-foreground"
                        >
                          {file.name}
                        </span>
                        {file.category ? (
                          <span className="shrink-0 rounded-md bg-background px-1.5 py-0.5 text-ui-xs text-foreground-subtle">
                            {intl.formatMessage({
                              id: `workspaceSidebar.memoryCategory.${file.category}`,
                            })}
                          </span>
                        ) : null}
                      </span>
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, file.name)}
                        className="mt-0.5 block truncate text-ui-sm text-foreground-subtle"
                      >
                        {file.missing
                          ? intl.formatMessage({
                              id: "settings.memory.viewer.missingIndex",
                            })
                          : formatMemoryUpdatedAt({
                              formatMessage: intl.formatMessage,
                              locale,
                              now,
                              updatedAt: file.updatedAt,
                            })}
                      </span>
                    </span>
                  </div>
                  {onDeleteFile && !file.missing ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-md"
                      className="shrink-0"
                      aria-label={intl.formatMessage(
                        { id: "settings.memory.viewer.deleteFile" },
                        { name: file.name },
                      )}
                      data-testid={testId(TID_WORKSPACE_MEMORY_DELETE, file.name)}
                      onClick={() => onDeleteFile(file)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  ) : null}
                  {file.missing ? null : (
                    <span
                      data-testid={testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, file.name)}
                      className="mr-3 shrink-0"
                    >
                      <WorkspaceEditorButtonGroup workspaceAbsPath={file.path} />
                    </span>
                  )}
                </div>
              </Fragment>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
