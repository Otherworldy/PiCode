import { useCallback, useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import type { IFileService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { runUserActionAsync } from "@/lib/userActionTelemetry.js";

const PROMPT_TEXTAREA_CLASS =
  "field-sizing-fixed h-64 max-h-64 min-h-64 w-full resize-none overflow-y-auto rounded-lg border border-input-border bg-input font-mono text-ui-base whitespace-pre-wrap break-words hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0";

export function AgentSystemPromptField({
  description,
  fileService,
  rootPath,
  scope,
  testIdPrefix,
}: {
  description: string;
  fileService: Pick<IFileService, "readAgentSystemPrompt" | "writeAgentSystemPrompt">;
  rootPath?: string;
  scope: "global" | "project";
  testIdPrefix: string;
}) {
  const { intl } = useZCodeIntl();
  const requestIdRef = useRef(0);
  const fileServiceRef = useRef(fileService);
  fileServiceRef.current = fileService;
  const [pathLabel, setPathLabel] = useState("");
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    if (scope === "project" && !rootPath?.trim()) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setLoading(true);
    setLoadFailed(false);
    try {
      const result = await fileServiceRef.current.readAgentSystemPrompt({ scope, rootPath });
      if (requestIdRef.current !== requestId) return;
      setDraft(result.content);
      setSaved(result.content);
      setPathLabel(result.path);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setLoadFailed(true);
      logger.warn("[AgentSystemPromptField] 读取系统提示词失败", {
        error: error instanceof Error ? error.message : String(error),
        scope,
      });
    } finally {
      if (requestIdRef.current === requestId) setLoading(false);
    }
  }, [rootPath, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = saved !== null && draft !== saved;
  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const result = await runUserActionAsync({
        input: {
          featureId: "settings.systemPrompt",
          action: scope === "global" ? "save_system_global" : "save_system_project",
          trigger: "button",
        },
        operation: () =>
          fileServiceRef.current.writeAgentSystemPrompt({ scope, rootPath, content: draft }),
        completed: { resultSource: "platform_result" },
        failureStage: "settings_commit",
      });
      setDraft(result.content);
      setSaved(result.content);
      setPathLabel(result.path);
      toast(intl.formatMessage({ id: "settings.systemPrompt.systemSaved" }));
    } catch (error) {
      logger.warn("[AgentSystemPromptField] 保存系统提示词失败", {
        error: error instanceof Error ? error.message : String(error),
        scope,
      });
      toast(intl.formatMessage({ id: "settings.systemPrompt.systemSaveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [dirty, draft, intl, rootPath, saving, scope]);

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.systemPrompt.systemTitle" })}
        </h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</p>
      </div>
      {pathLabel ? (
        <p className="break-all font-mono text-ui-sm text-foreground-subtle">{pathLabel}</p>
      ) : null}
      {loadFailed ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.systemPrompt.systemLoadFailed" })}
        </p>
      ) : (
        <Textarea
          aria-label={intl.formatMessage({ id: "settings.systemPrompt.systemTitle" })}
          className={PROMPT_TEXTAREA_CLASS}
          data-testid={`${testIdPrefix}-system-editor`}
          disabled={loading || saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              if (dirty && !saving && !loading) void save();
            }
          }}
          placeholder={intl.formatMessage({ id: "settings.systemPrompt.systemPlaceholder" })}
          spellCheck={false}
          value={draft}
        />
      )}
      <Button
        data-testid={`${testIdPrefix}-system-save`}
        disabled={!dirty || saving || loading}
        onClick={() => void save()}
        size="sm"
        type="button"
        variant="default"
      >
        <Save className="size-4" />
        {intl.formatMessage({ id: "settings.systemPrompt.save" })}
      </Button>
    </div>
  );
}
