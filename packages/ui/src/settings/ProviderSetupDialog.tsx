import { useRef, useState } from "react";
import { Check, Eye, EyeOff, Loader2, PlugZap, X } from "lucide-react";
import type { ZCodePiModelsMutateParams } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { ApiSelect, Field, ModelDraftList } from "@/settings/ModelDraftCard.js";
import {
  defaultChosen,
  slugProviderId,
  type CatalogView,
  type ProviderDraft,
} from "@/settings/provider-draft.js";

/**
 * 编辑/新建 AI 服务弹窗：
 * 取消分步向导，采用一体化单页结构（上方端点接入与认证，下方模型列表与配置），
 * 统一各表单元素与操作按钮规格，符合 PiCode 极简桌面端交互规范。
 */
export function ProviderSetupDialog({
  busy,
  draft,
  existingIds,
  mutate,
  onClose,
  onChange,
}: {
  busy: boolean;
  draft: ProviderDraft | null;
  existingIds: string[];
  mutate: (params: ZCodePiModelsMutateParams) => Promise<CatalogView>;
  onClose: () => void;
  onChange: (draft: ProviderDraft | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const [testingConnection, setTestingConnection] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const patch = (partial: Partial<ProviderDraft>) => {
    const current = draftRef.current;
    if (!current) return;
    onChange({ ...current, ...partial });
  };

  const fetchModels = async (importModels: boolean) => {
    const current = draftRef.current;
    if (!current?.baseUrl.trim()) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needNameUrl" }));
      return;
    }
    if (!importModels) {
      setTestingConnection(true);
    }
    try {
      const next = await mutate({
        action: "discover",
        providerId: current.id.trim() || undefined,
        provider: {
          id: current.id.trim() || "tmp",
          baseUrl: current.baseUrl.trim(),
          api: current.api,
          ...(current.apiKey.trim() ? { apiKey: current.apiKey.trim() } : {}),
          models: [],
        },
      });
      const list = next.discovered ?? [];
      const latest = draftRef.current ?? current;
      if (importModels) {
        const known = new Set(latest.models.map((model) => model.id));
        const added = list.filter((item) => !known.has(item.id)).map(defaultChosen);
        if (added.length > 0) onChange({ ...latest, models: [...latest.models, ...added] });
      }
      toast(
        intl.formatMessage({ id: "settings.modelProvider.pi.discoverOk" }, { count: list.length }),
      );
    } catch {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.discoverFailed" }));
    } finally {
      if (!importModels) {
        setTestingConnection(false);
      }
    }
  };

  const save = async () => {
    const current = draftRef.current;
    if (!current) return;
    const name = current.name.trim();
    const baseUrl = current.baseUrl.trim();
    if (!name || !baseUrl) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needNameUrl" }));
      return;
    }
    if (current.models.length === 0) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.needModels" }));
      return;
    }
    const id = current.existing ? current.id : current.id.trim() || slugProviderId(name, baseUrl);
    if (!current.existing && existingIds.includes(id)) {
      toast(intl.formatMessage({ id: "settings.modelProvider.pi.duplicateId" }));
      return;
    }
    await mutate({
      action: "upsert",
      provider: {
        id,
        name,
        baseUrl,
        api: current.api,
        apiKey: current.apiKey.trim(),
        models: current.models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.thinkingLevels.some((level) => level !== "off"),
          thinkingLevels: model.thinkingLevels,
          ...(model.defaultThinkingLevel
            ? { defaultThinkingLevel: model.defaultThinkingLevel }
            : {}),
          input: model.input,
          ...(model.api && model.api !== current.api ? { api: model.api } : {}),
        })),
      },
    });
    onClose();
  };

  return (
    <Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[min(48rem,calc(100dvh-2rem))] max-w-3xl flex-col gap-0 overflow-hidden p-0">
        {/* 弹窗标题栏 */}
        <DialogHeader className="shrink-0 flex-row items-center justify-between border-b border-border px-5 py-3.5 pr-12">
          <div className="flex items-center gap-2.5">
            <DialogTitle className="text-ui-base font-semibold">
              {intl.formatMessage({
                id: draft?.existing
                  ? "settings.modelProvider.pi.editService"
                  : "settings.modelProvider.pi.addService",
              })}
            </DialogTitle>
            {draft?.id ? (
              <span className="rounded-md border border-border bg-surface px-1.5 py-0.5 font-mono text-ui-xs text-foreground-subtle">
                {draft.id}
              </span>
            ) : null}
          </div>
        </DialogHeader>

        {/* 主体连续滚动内容：上部端点与认证，下部模型列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto p-5 space-y-6">
          {draft ? (
            <>
              {/* Section 1: 端点接入与凭据 */}
              <section className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({ id: "settings.modelProvider.pi.endpoint" })}
                  </h3>
                  <span className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.modelProvider.pi.apiKeyKeep" })}
                  </span>
                </div>

                <div className="rounded-lg border border-border bg-surface/50 p-3.5 space-y-3">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={intl.formatMessage({ id: "settings.modelProvider.name" })}>
                      <Input
                        size="lg"
                        value={draft.name}
                        onChange={(event) => patch({ name: event.target.value })}
                        placeholder="例如 DeepSeek"
                      />
                    </Field>
                    <Field
                      label={intl.formatMessage({ id: "settings.modelProvider.pi.providerId" })}
                    >
                      <Input
                        size="lg"
                        className="font-mono"
                        disabled={draft.existing}
                        value={draft.id}
                        onChange={(event) => patch({ id: event.target.value })}
                        placeholder="例如 deepseek"
                      />
                    </Field>
                  </div>

                  {/* 接口地址 + 测试连接复合输入行 */}
                  <div className="space-y-1">
                    <label className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({ id: "settings.modelProvider.baseUrl" })}
                    </label>
                    <div className="flex items-center gap-2">
                      <Input
                        size="lg"
                        className="flex-1 font-mono"
                        value={draft.baseUrl}
                        onChange={(event) => patch({ baseUrl: event.target.value })}
                        placeholder="https://api.example.com/v1"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="lg"
                        disabled={busy || testingConnection || !draft.baseUrl.trim()}
                        onClick={() => void fetchModels(false)}
                        className="shrink-0"
                      >
                        {testingConnection ? <Loader2 className="animate-spin" /> : <PlugZap />}
                        {intl.formatMessage({ id: "settings.modelProvider.pi.testConnection" })}
                      </Button>
                    </div>
                  </div>

                  {/* API 密钥（带明密文切换） */}
                  <div className="space-y-1">
                    <label className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({ id: "settings.modelProvider.apiKey" })}
                    </label>
                    <div className="relative flex items-center">
                      <Input
                        size="lg"
                        type={showApiKey ? "text" : "password"}
                        className="font-mono pr-10"
                        value={draft.apiKey}
                        onChange={(event) => patch({ apiKey: event.target.value })}
                        placeholder="sk-..."
                      />
                      <button
                        type="button"
                        onClick={() => setShowApiKey(!showApiKey)}
                        className="absolute right-2.5 text-foreground-subtle hover:text-foreground transition-colors"
                        title={showApiKey ? "隐藏密钥" : "显示密钥"}
                      >
                        {showApiKey ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                      </button>
                    </div>
                  </div>

                  {/* 默认协议选择 */}
                  <Field label={intl.formatMessage({ id: "settings.modelProvider.pi.defaultApi" })}>
                    <ApiSelect value={draft.api} onChange={(value) => patch({ api: value })} />
                  </Field>
                </div>
              </section>

              {/* Section 2: 模型列表管理与配置 */}
              <section className="space-y-3">
                <ModelDraftList
                  busy={busy}
                  draft={draft}
                  onChange={onChange}
                  onFetch={() => void fetchModels(true)}
                />
              </section>
            </>
          ) : null}
        </div>

        {/* 弹窗底部统一操作栏 */}
        <DialogFooter className="shrink-0 border-t border-border px-5 py-3 sm:justify-between">
          <div className="flex items-center gap-2 text-ui-xs text-foreground-subtle">
            <span>{draft ? `已添加 ${draft.models.length} 个模型` : ""}</span>
          </div>

          <div className="flex gap-2">
            <Button type="button" variant="outline" size="lg" onClick={onClose}>
              <X />
              {intl.formatMessage({ id: "settings.modelProvider.cancel" })}
            </Button>
            <Button type="button" size="lg" disabled={busy} onClick={() => void save()}>
              <Check />
              {intl.formatMessage({ id: "settings.modelProvider.pi.saveService" })}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
