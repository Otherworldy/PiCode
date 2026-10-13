import { useCallback, useEffect, useRef, useState } from "react";
import type { IFileService } from "@zcode/services";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { WorkspaceProjectCommandList } from "@/WorkspaceSidebar/WorkspaceProjectCommandList.js";

type CommandDraft = {
  directory: string;
  files: string[];
  selected: string | null;
  draft: string;
  saved: string | null;
  loading: boolean;
  failed: boolean;
};

const NEW_PROMPT = "---\ndescription:\n---\n";
const EDITOR_CLASS =
  "field-sizing-fixed min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent px-4 py-3 font-mono text-ui-base whitespace-pre-wrap break-words shadow-none focus-visible:ring-0";
const EMPTY_COMMANDS: CommandDraft = {
  directory: "",
  files: [],
  selected: null,
  draft: "",
  saved: null,
  loading: true,
  failed: false,
};

function promptFileNameFromLabel(label: string): string {
  const trimmed = label.trim();
  const base = trimmed.toLowerCase().endsWith(".md") ? trimmed.slice(0, -3).trim() : trimmed;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(base)) {
    throw new Error("Invalid prompt name");
  }
  return `${base}.md`;
}

function isDirty(state: CommandDraft): boolean {
  return state.selected !== null && state.saved !== null && state.draft !== state.saved;
}

export function WorkspaceProjectCommandPane({
  fileService,
  onActivity,
  workspacePath,
}: {
  fileService: Pick<
    IFileService,
    "deleteAgentPrompt" | "listAgentPrompts" | "readAgentPrompt" | "writeAgentPrompt"
  >;
  onActivity: (activity: {
    busy: boolean;
    dirty: boolean;
    discard: () => void;
    save: () => Promise<void>;
  }) => void;
  workspacePath: string;
}) {
  const { intl } = useZCodeIntl();
  const confirm = useConfirmDialog();
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;
  const [commands, setCommands] = useState<CommandDraft>(EMPTY_COMMANDS);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const readCommand = useCallback(
    async (name: string) => {
      setCommands((state) => ({ ...state, loading: true, failed: false }));
      try {
        const file = await fileServiceRef.current.readAgentPrompt({
          scope: "project",
          rootPath: workspacePath,
          name,
        });
        setCommands((state) => ({
          ...state,
          directory: file.directory,
          selected: file.name,
          draft: file.content,
          saved: file.content,
          loading: false,
          failed: false,
        }));
      } catch (error) {
        setCommands((state) => ({ ...state, loading: false, failed: true }));
        logger.warn("[WorkspaceProjectCommandPane] 打开斜杠命令失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [workspacePath],
  );

  useEffect(() => {
    let cancelled = false;
    setCommands(EMPTY_COMMANDS);
    void (async () => {
      try {
        const listed = await fileServiceRef.current.listAgentPrompts({
          scope: "project",
          rootPath: workspacePath,
        });
        if (cancelled) return;
        const selected = listed.files[0] ?? null;
        if (!selected) {
          setCommands({
            directory: listed.directory,
            files: listed.files,
            selected: null,
            draft: "",
            saved: "",
            loading: false,
            failed: false,
          });
          return;
        }
        const file = await fileServiceRef.current.readAgentPrompt({
          scope: "project",
          rootPath: workspacePath,
          name: selected,
        });
        if (cancelled) return;
        setCommands({
          directory: file.directory,
          files: listed.files,
          selected: file.name,
          draft: file.content,
          saved: file.content,
          loading: false,
          failed: false,
        });
      } catch (error) {
        if (cancelled) return;
        setCommands((state) => ({ ...state, loading: false, failed: true }));
        logger.warn("[WorkspaceProjectCommandPane] 读取斜杠命令失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspacePath]);

  const save = useCallback(async () => {
    if (!isDirty(commands) || saving || !commands.selected) return;
    const name = commands.selected;
    setSaving(true);
    try {
      await runUserActionAsync({
        input: { featureId: "settings.systemPrompt", action: "save_project", trigger: "button" },
        operation: () =>
          fileServiceRef.current.writeAgentPrompt({
            scope: "project",
            rootPath: workspacePath,
            name,
            content: commands.draft,
          }),
        completed: { resultSource: "platform_result" },
        failureStage: "settings_commit",
      });
      setCommands((state) => ({ ...state, saved: state.draft }));
      toast(intl.formatMessage({ id: "settings.systemPrompt.saved" }));
    } catch (error) {
      logger.warn("[WorkspaceProjectCommandPane] 保存斜杠命令失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [commands, intl, saving, workspacePath]);

  const discard = useCallback(() => {
    setCommands((state) => ({ ...state, draft: state.saved ?? "" }));
  }, []);

  useEffect(() => {
    onActivity({
      busy: commands.loading || commands.failed || saving,
      dirty: isDirty(commands),
      discard,
      save,
    });
  }, [commands, discard, onActivity, save, saving]);

  const openCommand = useCallback(
    async (name: string) => {
      if (name === commands.selected || saving) return;
      if (isDirty(commands)) {
        const accepted = await confirm({
          title: intl.formatMessage({ id: "settings.systemPrompt.unsavedTitle" }),
          confirmLabel: intl.formatMessage({ id: "settings.systemPrompt.discard" }),
          confirmVariant: "destructive",
        });
        if (!accepted) return;
      }
      await readCommand(name);
    },
    [commands, confirm, intl, readCommand, saving],
  );

  const createCommand = useCallback(async () => {
    let name: string;
    try {
      name = promptFileNameFromLabel(newName);
    } catch {
      toast(intl.formatMessage({ id: "settings.systemPrompt.invalidName" }));
      return;
    }
    if (isDirty(commands)) {
      const accepted = await confirm({
        title: intl.formatMessage({ id: "settings.systemPrompt.unsavedTitle" }),
        confirmLabel: intl.formatMessage({ id: "settings.systemPrompt.discard" }),
        confirmVariant: "destructive",
      });
      if (!accepted) return;
    }
    setCreating(false);
    setNewName("");
    if (commands.files.includes(name)) {
      await readCommand(name);
      return;
    }
    setSaving(true);
    try {
      await fileServiceRef.current.writeAgentPrompt({
        scope: "project",
        rootPath: workspacePath,
        name,
        content: NEW_PROMPT,
      });
      setCommands((state) => ({
        ...state,
        files: [...state.files, name].sort((left, right) => left.localeCompare(right)),
        selected: name,
        draft: NEW_PROMPT,
        saved: NEW_PROMPT,
        failed: false,
      }));
    } catch (error) {
      logger.warn("[WorkspaceProjectCommandPane] 新建斜杠命令失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [commands, confirm, intl, newName, readCommand, workspacePath]);

  const deleteCommand = useCallback(
    async (name: string) => {
      if (saving) return;
      const accepted = await confirm({
        title: intl.formatMessage({ id: "settings.systemPrompt.deleteTitle" }),
        description: intl.formatMessage(
          { id: "settings.systemPrompt.deleteDescription" },
          { name },
        ),
        confirmLabel: intl.formatMessage({ id: "settings.systemPrompt.delete" }),
        confirmVariant: "destructive",
      });
      if (!accepted) return;
      setSaving(true);
      try {
        await runUserActionAsync({
          input: {
            featureId: "settings.systemPrompt",
            action: "delete_project",
            trigger: "button",
          },
          operation: () =>
            fileServiceRef.current.deleteAgentPrompt({
              scope: "project",
              rootPath: workspacePath,
              name,
            }),
          completed: { resultSource: "platform_result" },
          failureStage: "settings_commit",
        });
        toast(intl.formatMessage({ id: "settings.systemPrompt.deleted" }));
        const files = commands.files.filter((file) => file !== name);
        const next = commands.selected === name ? (files[0] ?? null) : commands.selected;
        if (!next) {
          setCommands((state) => ({
            ...state,
            files,
            selected: null,
            draft: "",
            saved: "",
            loading: false,
          }));
          return;
        }
        if (next !== commands.selected) {
          setCommands((state) => ({ ...state, files }));
          await readCommand(next);
          return;
        }
        setCommands((state) => ({ ...state, files }));
      } catch (error) {
        logger.warn("[WorkspaceProjectCommandPane] 删除斜杠命令失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.systemPrompt.saveFailed" }));
      } finally {
        setSaving(false);
      }
    },
    [commands.files, commands.selected, confirm, intl, readCommand, saving, workspacePath],
  );

  const hint = commands.selected
    ? intl.formatMessage(
        { id: "workspaceSidebar.systemPrompt.commandHint" },
        { command: commands.selected.replace(/\.md$/u, "") },
      )
    : "";
  const path = commands.selected
    ? `${commands.directory.replace(/[/\\]$/u, "")}/${commands.selected}`
    : commands.directory;

  return (
    <div className="flex min-h-0 flex-1">
      <WorkspaceProjectCommandList
        creating={creating}
        directory={commands.directory}
        failed={commands.failed}
        files={commands.files}
        loading={commands.loading}
        newName={newName}
        onCreate={() => void createCommand()}
        onDelete={(name) => void deleteCommand(name)}
        onNameChange={setNewName}
        onOpen={(name) => void openCommand(name)}
        onStartCreate={() => setCreating(true)}
        onStopCreate={() => {
          setCreating(false);
          setNewName("");
        }}
        saving={saving}
        selected={commands.selected}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2">
          <p className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">{path}</p>
          {hint ? <p className="shrink-0 text-ui-sm text-foreground-subtle">{hint}</p> : null}
        </div>
        {commands.failed ? null : (
          <Textarea
            aria-label={intl.formatMessage({ id: "workspaceSidebar.systemPrompt.commands" })}
            className={EDITOR_CLASS}
            data-testid="workspace-system-prompt-editor"
            disabled={!commands.selected || commands.loading || saving}
            onChange={(event) => setCommands((state) => ({ ...state, draft: event.target.value }))}
            spellCheck={false}
            value={commands.selected ? commands.draft : ""}
          />
        )}
      </div>
    </div>
  );
}
