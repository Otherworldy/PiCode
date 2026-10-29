import { useCallback, useEffect, useRef, useState } from "react";
import type { IFileService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  SETTINGS_SEGMENTED_TABS_LIST_CLASS,
  SETTINGS_SEGMENTED_TABS_TRIGGER_CLASS,
} from "@/settings/SettingsSegmentedTabs.js";
import { WorkspaceProjectCommandPane } from "@/WorkspaceSidebar/WorkspaceProjectCommandPane.js";

type PromptKind = "append" | "replace";
type TabId = PromptKind | "commands";
type TextDraft = {
  path: string;
  draft: string;
  saved: string | null;
  loading: boolean;
  failed: boolean;
};
type CommandActivity = {
  busy: boolean;
  dirty: boolean;
  discard: () => void;
  save: () => Promise<void>;
};

const EMPTY_TEXT: TextDraft = {
  path: "",
  draft: "",
  saved: null,
  loading: true,
  failed: false,
};
const EDITOR_CLASS =
  "field-sizing-fixed min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-ui-base whitespace-pre-wrap break-words shadow-none focus-visible:ring-0";

function textDirty(state: TextDraft): boolean {
  return state.saved !== null && state.draft !== state.saved;
}

export function WorkspaceSystemPromptDialog({
  fileService,
  onOpenChange,
  open,
  workspaceLabel,
  workspacePath,
}: {
  fileService: Pick<
    IFileService,
    | "deleteAgentPrompt"
    | "listAgentPrompts"
    | "readAgentPrompt"
    | "readAgentSystemPrompt"
    | "writeAgentPrompt"
    | "writeAgentSystemPrompt"
  >;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceLabel: string;
  workspacePath: string;
}) {
  const { intl } = useZCodeIntl();
  const confirm = useConfirmDialog();
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;
  const commandActivity = useRef<CommandActivity>({
    busy: true,
    dirty: false,
    discard: () => undefined,
    save: async () => undefined,
  });
  const [tab, setTab] = useState<TabId>("append");
  const [append, setAppend] = useState<TextDraft>(EMPTY_TEXT);
  const [replace, setReplace] = useState<TextDraft>(EMPTY_TEXT);
  const [saving, setSaving] = useState(false);
  const [commandDirty, setCommandDirty] = useState(false);
  const [commandBusy, setCommandBusy] = useState(true);
  const text = tab === "replace" ? replace : append;
  const dirty = tab === "commands" ? commandDirty : textDirty(text);
  const busy = saving || (tab === "commands" ? commandBusy : text.loading || text.failed);

  const onCommandActivity = useCallback((activity: CommandActivity) => {
    commandActivity.current = activity;
    setCommandDirty((current) => (current === activity.dirty ? current : activity.dirty));
    setCommandBusy((current) => (current === activity.busy ? current : activity.busy));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setAppend(EMPTY_TEXT);
    setReplace(EMPTY_TEXT);
    const loadText = async (kind: PromptKind) => {
      const setDraft = kind === "append" ? setAppend : setReplace;
      try {
        const file = await fileServiceRef.current.readAgentSystemPrompt({
          scope: "project",
          rootPath: workspacePath,
          kind,
        });
        if (cancelled) return;
        setDraft({
          path: file.path,
          draft: file.content,
          saved: file.content,
          loading: false,
          failed: false,
        });
      } catch (error) {
        if (cancelled) return;
        setDraft((state) => ({ ...state, loading: false, failed: true }));
        logger.warn("[WorkspaceSystemPromptDialog] 读取系统提示词失败", {
          error: error instanceof Error ? error.message : String(error),
          kind,
        });
      }
    };
    void loadText("append");
    void loadText("replace");
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const confirmDiscard = useCallback(async () => {
    if (!dirty) return true;
    return confirm({
      title: intl.formatMessage({ id: "settings.systemPrompt.unsavedTitle" }),
      confirmLabel: intl.formatMessage({ id: "settings.systemPrompt.discard" }),
      confirmVariant: "destructive",
    });
  }, [confirm, dirty, intl]);

  const discardCurrent = useCallback(() => {
    if (tab === "commands") {
      commandActivity.current.discard();
      return;
    }
    const setDraft = tab === "replace" ? setReplace : setAppend;
    setDraft((state) => ({ ...state, draft: state.saved ?? "" }));
  }, [tab]);

  const selectTab = useCallback(
    async (next: string) => {
      if (next !== "append" && next !== "replace" && next !== "commands") return;
      if (next === tab || saving) return;
      if (!(await confirmDiscard())) return;
      discardCurrent();
      setTab(next);
    },
    [confirmDiscard, discardCurrent, saving, tab],
  );

  const requestClose = useCallback(async () => {
    if (saving) return;
    if (!(await confirmDiscard())) return;
    onOpenChange(false);
  }, [confirmDiscard, onOpenChange, saving]);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    if (tab === "commands") {
      await commandActivity.current.save();
      return;
    }
    const kind = tab;
    const content = text.draft;
    setSaving(true);
    try {
      const result = await fileServiceRef.current.writeAgentSystemPrompt({
        scope: "project",
        rootPath: workspacePath,
        kind,
        content,
      });
      const next = {
        path: result.path,
        draft: result.content,
        saved: result.content,
        loading: false,
        failed: false,
      };
      if (kind === "append") setAppend(next);
      else setReplace(next);
      toast(intl.formatMessage({ id: "settings.systemPrompt.systemSaved" }));
    } catch (error) {
      logger.warn("[WorkspaceSystemPromptDialog] 保存系统提示词失败", {
        error: error instanceof Error ? error.message : String(error),
        kind,
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.systemSaveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [dirty, intl, saving, tab, text.draft, workspacePath]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          void requestClose();
          return;
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        className="flex h-[min(40rem,calc(100vh-4rem))] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            void save();
          }
        }}
      >
        <DialogHeader className="gap-1 border-b border-border px-4 py-3 pr-12">
          <div className="flex min-w-0 items-center gap-3">
            <DialogTitle>{intl.formatMessage({ id: "workspaceSidebar.systemPrompt" })}</DialogTitle>
            <DialogDescription className="truncate font-mono text-ui-sm">
              {workspaceLabel}
            </DialogDescription>
          </div>
        </DialogHeader>
        <Tabs
          className="min-h-0 flex-1 gap-0"
          onValueChange={(value) => void selectTab(value)}
          value={tab}
        >
          <div className="border-b border-border px-4 py-2.5">
            <TabsList className={SETTINGS_SEGMENTED_TABS_LIST_CLASS}>
              <TabsTrigger className={SETTINGS_SEGMENTED_TABS_TRIGGER_CLASS} value="append">
                {intl.formatMessage({ id: "workspaceSidebar.systemPrompt.append" })}
              </TabsTrigger>
              <TabsTrigger className={SETTINGS_SEGMENTED_TABS_TRIGGER_CLASS} value="replace">
                {intl.formatMessage({ id: "workspaceSidebar.systemPrompt.replace" })}
              </TabsTrigger>
              <TabsTrigger className={SETTINGS_SEGMENTED_TABS_TRIGGER_CLASS} value="commands">
                {intl.formatMessage({ id: "workspaceSidebar.systemPrompt.commands" })}
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent className="flex min-h-0 flex-col overflow-hidden" value="append">
            <SystemTextPane
              failed={append.failed}
              hint={intl.formatMessage({ id: "workspaceSidebar.systemPrompt.appendHint" })}
              label={intl.formatMessage({ id: "workspaceSidebar.systemPrompt.append" })}
              loading={append.loading}
              onChange={(draft) => setAppend((state) => ({ ...state, draft }))}
              path={append.path}
              saving={saving}
              testId="workspace-system-prompt-append-editor"
              value={append.draft}
            />
          </TabsContent>
          <TabsContent className="flex min-h-0 flex-col overflow-hidden" value="replace">
            <SystemTextPane
              failed={replace.failed}
              hint={intl.formatMessage({ id: "workspaceSidebar.systemPrompt.replaceHint" })}
              label={intl.formatMessage({ id: "workspaceSidebar.systemPrompt.replace" })}
              loading={replace.loading}
              onChange={(draft) => setReplace((state) => ({ ...state, draft }))}
              path={replace.path}
              saving={saving}
              testId="workspace-system-prompt-system-editor"
              value={replace.draft}
            />
          </TabsContent>
          <TabsContent className="flex min-h-0 overflow-hidden" value="commands">
            <WorkspaceProjectCommandPane
              fileService={fileService}
              onActivity={onCommandActivity}
              workspacePath={workspacePath}
            />
          </TabsContent>
        </Tabs>
        <DialogFooter className="border-t border-border px-4 py-3 sm:justify-between">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "workspaceSidebar.systemPrompt.pending" })}
          </p>
          <div className="flex items-center gap-2">
            <Button onClick={() => void requestClose()} size="lg" type="button" variant="outline">
              {intl.formatMessage({ id: "common.cancel" })}
            </Button>
            <Button
              data-testid="workspace-system-prompt-save"
              disabled={!dirty || busy}
              onClick={() => void save()}
              size="lg"
              type="button"
            >
              {intl.formatMessage({ id: "settings.systemPrompt.save" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SystemTextPane({
  failed,
  hint,
  label,
  loading,
  onChange,
  path,
  saving,
  testId,
  value,
}: {
  failed: boolean;
  hint: string;
  label: string;
  loading: boolean;
  onChange: (value: string) => void;
  path: string;
  saving: boolean;
  testId: string;
  value: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
        <p className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">{path}</p>
        {hint ? <p className="shrink-0 text-ui-sm text-foreground-subtle">{hint}</p> : null}
      </div>
      {failed ? (
        <p className="px-4 py-3 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPrompt.systemLoadFailed" })}
        </p>
      ) : (
        <Textarea
          aria-label={label}
          className={EDITOR_CLASS}
          data-testid={testId}
          disabled={loading || saving}
          onChange={(event) => onChange(event.target.value)}
          spellCheck={false}
          value={value}
        />
      )}
    </div>
  );
}
