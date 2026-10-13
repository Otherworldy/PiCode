import { useCallback, useEffect, useRef, useState } from "react";
import { Save, Trash2 } from "lucide-react";
import type { IFileService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { cn } from "@/components/lib/utils.js";

type PromptFileService = Pick<
  IFileService,
  "deleteAgentPrompt" | "listAgentPrompts" | "readAgentPrompt" | "writeAgentPrompt"
>;

const NEW_PROMPT = "---\ndescription:\n---\n";

function promptFileNameFromLabel(label: string): string {
  const trimmed = label.trim();
  const base = trimmed.toLowerCase().endsWith(".md") ? trimmed.slice(0, -3).trim() : trimmed;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(base)) {
    throw new Error("Invalid prompt name");
  }
  return `${base}.md`;
}

export function SystemPromptEditor({
  description,
  editorLabel,
  fileService,
  rootPath,
  scope,
  testIdPrefix,
}: {
  description: string;
  editorLabel: string;
  fileService: PromptFileService;
  rootPath?: string;
  scope: "global" | "project";
  testIdPrefix: string;
}) {
  const { intl } = useZCodeIntl();
  const confirm = useConfirmDialog();
  const requestIdRef = useRef(0);
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;
  const [directory, setDirectory] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const loadList = useCallback(
    async (prefer?: string) => {
      if (scope === "project" && !rootPath?.trim()) return;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      setLoadFailed(false);
      try {
        const listed = await fileServiceRef.current.listAgentPrompts({ scope, rootPath });
        if (requestIdRef.current !== requestId) return;
        setDirectory(listed.directory);
        setFiles(listed.files);
        const next = prefer && listed.files.includes(prefer) ? prefer : (listed.files[0] ?? null);
        setSelected(next);
        if (!next) {
          setDraft("");
          setSaved("");
          setLoading(false);
          return;
        }
        const file = await fileServiceRef.current.readAgentPrompt({ scope, rootPath, name: next });
        if (requestIdRef.current !== requestId) return;
        setDraft(file.content);
        setSaved(file.content);
      } catch (error) {
        if (requestIdRef.current !== requestId) return;
        setLoadFailed(true);
        logger.warn("[SystemPromptEditor] 读取提示词失败", {
          error: error instanceof Error ? error.message : String(error),
          scope,
        });
      } finally {
        if (requestIdRef.current === requestId) setLoading(false);
      }
    },
    [rootPath, scope],
  );

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const dirty = saved !== null && draft !== saved;

  const openFile = useCallback(
    async (name: string) => {
      if (name === selected) return;
      if (dirty) {
        const leave = await confirm({
          title: intl.formatMessage({ id: "settings.systemPrompt.unsavedTitle" }),
          confirmLabel: intl.formatMessage({ id: "settings.systemPrompt.discard" }),
          confirmVariant: "destructive",
        });
        if (!leave) return;
      }
      setLoading(true);
      try {
        const file = await fileServiceRef.current.readAgentPrompt({ scope, rootPath, name });
        setSelected(file.name);
        setDraft(file.content);
        setSaved(file.content);
        setLoadFailed(false);
      } catch (error) {
        logger.warn("[SystemPromptEditor] 打开提示词失败", {
          error: error instanceof Error ? error.message : String(error),
          scope,
        });
        toast(intl.formatMessage({ id: "settings.systemPrompt.loadFailed" }));
      } finally {
        setLoading(false);
      }
    },
    [confirm, dirty, intl, rootPath, scope, selected],
  );

  const save = useCallback(async () => {
    if (!selected || !dirty || saving) return;
    setSaving(true);
    try {
      const result = await runUserActionAsync({
        input: {
          featureId: "settings.systemPrompt",
          action: scope === "global" ? "save_global" : "save_project",
          trigger: "button",
        },
        operation: () =>
          fileServiceRef.current.writeAgentPrompt({
            scope,
            rootPath,
            name: selected,
            content: draft,
          }),
        completed: { resultSource: "platform_result" },
        failureStage: "settings_commit",
      });
      setDraft(draft);
      setSaved(draft);
      setDirectory(result.directory);
      toast(intl.formatMessage({ id: "settings.systemPrompt.saved" }));
    } catch (error) {
      logger.warn("[SystemPromptEditor] 保存提示词失败", {
        error: error instanceof Error ? error.message : String(error),
        scope,
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, intl, rootPath, saving, scope, selected]);

  const createFile = useCallback(async () => {
    let name: string;
    try {
      name = promptFileNameFromLabel(newName);
    } catch {
      toast(intl.formatMessage({ id: "settings.systemPrompt.invalidName" }));
      return;
    }
    if (files.includes(name)) {
      await openFile(name);
      return;
    }
    setSaving(true);
    try {
      await fileServiceRef.current.writeAgentPrompt({
        scope,
        rootPath,
        name,
        content: NEW_PROMPT,
      });
      setNewName("");
      await loadList(name);
    } catch (error) {
      logger.warn("[SystemPromptEditor] 新建提示词失败", {
        error: error instanceof Error ? error.message : String(error),
        scope,
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [files, intl, loadList, newName, openFile, rootPath, scope]);

  const removeFile = useCallback(async () => {
    if (!selected) return;
    const accepted = await confirm({
      title: intl.formatMessage({ id: "settings.systemPrompt.deleteTitle" }),
      description: intl.formatMessage(
        { id: "settings.systemPrompt.deleteDescription" },
        { name: selected },
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
          action: scope === "global" ? "delete_global" : "delete_project",
          trigger: "button",
        },
        operation: () =>
          fileServiceRef.current.deleteAgentPrompt({ scope, rootPath, name: selected }),
        completed: { resultSource: "platform_result" },
        failureStage: "settings_commit",
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.deleted" }));
      await loadList();
    } catch (error) {
      logger.warn("[SystemPromptEditor] 删除提示词失败", {
        error: error instanceof Error ? error.message : String(error),
        scope,
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [confirm, intl, loadList, rootPath, scope, selected]);

  return (
    <div className="space-y-3">
      {description ? (
        <p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
      ) : null}
      {directory || selected ? (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">
            {directory}
          </p>
          {selected ? (
            <p className="shrink-0 text-ui-sm text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.systemPrompt.commandHint" },
                { command: selected.replace(/\.md$/u, "") },
              )}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex gap-2">
        <Input
          aria-label={intl.formatMessage({ id: "settings.systemPrompt.newPlaceholder" })}
          disabled={loading || saving}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void createFile();
            }
          }}
          placeholder={intl.formatMessage({ id: "settings.systemPrompt.newPlaceholder" })}
          value={newName}
        />
        <Button
          disabled={loading || saving || !newName.trim()}
          onClick={() => void createFile()}
          size="sm"
          type="button"
          variant="outline"
        >
          {intl.formatMessage({ id: "settings.systemPrompt.new" })}
        </Button>
      </div>
      {loadFailed ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPrompt.loadFailed" })}
        </p>
      ) : (
        <div className="grid gap-3 md:grid-cols-[12rem_minmax(0,1fr)]">
          <div className="flex h-64 flex-col gap-1 overflow-y-auto rounded-lg border border-input-border bg-input p-1">
            {files.length === 0 ? (
              <p className="px-2 py-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.systemPrompt.empty" })}
              </p>
            ) : (
              files.map((name) => (
                <button
                  key={name}
                  className={cn(
                    "truncate rounded-md px-2 py-1 text-left font-mono text-ui-sm",
                    name === selected
                      ? "bg-surface-hover text-foreground"
                      : "text-foreground-subtle hover:bg-surface-hover hover:text-foreground",
                  )}
                  disabled={loading || saving}
                  onClick={() => void openFile(name)}
                  type="button"
                >
                  {name}
                </button>
              ))
            )}
          </div>
          <Textarea
            aria-label={editorLabel}
            className="field-sizing-fixed h-64 max-h-64 min-h-64 w-full resize-none overflow-y-auto rounded-lg border border-input-border bg-input font-mono text-ui-base whitespace-pre-wrap break-words hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0"
            data-testid={`${testIdPrefix}-editor`}
            disabled={!selected || loading || saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                if (dirty && !saving && !loading) void save();
              }
            }}
            placeholder={intl.formatMessage({ id: "settings.systemPrompt.placeholder" })}
            spellCheck={false}
            value={selected ? draft : ""}
          />
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          data-testid={`${testIdPrefix}-save`}
          disabled={!selected || !dirty || saving || loading}
          onClick={() => void save()}
          size="sm"
          type="button"
          variant="default"
        >
          <Save className="size-4" />
          {intl.formatMessage({ id: "settings.systemPrompt.save" })}
        </Button>
        <Button
          disabled={!selected || saving || loading}
          onClick={() => void removeFile()}
          size="sm"
          type="button"
          variant="outline"
        >
          <Trash2 className="size-4" />
          {intl.formatMessage({ id: "settings.systemPrompt.delete" })}
        </Button>
      </div>
    </div>
  );
}
