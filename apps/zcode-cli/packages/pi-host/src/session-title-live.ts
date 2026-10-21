import { completePiPrompt, listPiCatalog } from "./session-factory.js";
import { piCoding } from "./pi-sdk.js";
import {
  cleanSummarizedTitle,
  readTitleSummarySettings,
  scheduleSessionTitleSummary,
  TITLE_SUMMARY_SYSTEM_PROMPT,
  titleExcerptFromJsonl,
  titleExcerptFromRows,
  titleSummaryRequest,
  type ForkTitlePlaceholder,
  type TitleSummaryRow,
  type TitleSummarySettings,
} from "./session-title-summary.js";

export function scheduleLiveSessionTitleSummary(input: {
  sessionId: string;
  parentSessionId?: string;
  titleSource?: string;
  sessionName?: string;
  /** 用户手动 fork 出来的分支。传了就只总结分叉点之后的第一轮。 */
  forkTitle?: ForkTitlePlaceholder;
  rows: readonly TitleSummaryRow[];
  fallbackProvider?: string;
  fallbackModel?: string;
  stillEligible: () => boolean;
  commit: (title: string) => void;
  /** 会话自己的模型请求已经发出后再开始。之后与这一轮并行，不取消。 */
  ready?: () => Promise<void>;
  /** 测试注入。缺省走 Pi 目录里的模型。 */
  complete?: (request: {
    providerId: string;
    modelId: string;
    system: string;
    prompt: string;
  }) => Promise<string | null>;
  /** 测试注入。缺省读 `~/.pi/agent/zcode-title-summary.json`。 */
  readSettings?: () => Promise<TitleSummarySettings>;
}): void {
  scheduleSessionTitleSummary({
    ...input,
    readSettings:
      input.readSettings ?? (() => readTitleSummarySettings(piCoding().getAgentDir())),
    complete: async (request) => {
      await input.ready?.();
      if (!input.stillEligible()) return null;
      return (input.complete ?? completePiPrompt)({
        providerId: request.providerId,
        modelId: request.modelId,
        prompt: request.prompt,
        system: request.system,
      });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error("session title summary failed", input.sessionId, message);
    },
  });
}

/** 右键「总结标题」：忽略自动开关，指定模型失败时改用这次对话或全局默认模型。 */
export async function generateSessionTitleText(input: {
  userTexts: readonly string[];
  assistantText?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
}): Promise<string> {
  const prompt = titleSummaryRequest(input.userTexts, input.assistantText);
  if (!prompt) throw new Error("session has no summarizable text");
  const settings = await readTitleSummarySettings(piCoding().getAgentDir());
  const configured =
    settings.provider && settings.model
      ? { providerId: settings.provider, modelId: settings.model }
      : undefined;
  let fallback =
    input.fallbackProvider?.trim() && input.fallbackModel?.trim()
      ? { providerId: input.fallbackProvider.trim(), modelId: input.fallbackModel.trim() }
      : undefined;
  if (!configured && !fallback) {
    const catalog = await listPiCatalog().catch(() => null);
    if (catalog?.defaultProvider && catalog?.defaultModel) {
      fallback = { providerId: catalog.defaultProvider, modelId: catalog.defaultModel };
    }
  }
  const requestFor = (model: { providerId: string; modelId: string }) => ({
    providerId: model.providerId,
    modelId: model.modelId,
    system: TITLE_SUMMARY_SYSTEM_PROMPT,
    prompt,
  });
  const sameModel =
    configured !== undefined &&
    fallback !== undefined &&
    fallback.providerId === configured.providerId &&
    fallback.modelId === configured.modelId;
  let raw: string | null = null;
  if (configured) {
    try {
      raw = await completePiPrompt(requestFor(configured));
    } catch (error) {
      if (!fallback || sameModel) throw error;
    }
  }
  if (!raw && fallback && !sameModel) raw = await completePiPrompt(requestFor(fallback));
  const title = raw ? cleanSummarizedTitle(raw) : "";
  if (!title) throw new Error("session title summary was empty");
  return title;
}

export async function summarizeSessionTitleContent(input: {
  rows?: readonly TitleSummaryRow[];
  jsonl?: string;
  fallbackProvider?: string;
  fallbackModel?: string;
}): Promise<string> {
  const fromRows = input.rows ? titleExcerptFromRows(input.rows) : { userTexts: [] as string[] };
  const fromFile = input.jsonl ? titleExcerptFromJsonl(input.jsonl) : null;
  return generateSessionTitleText({
    userTexts: fromRows.userTexts.length > 0 ? fromRows.userTexts : (fromFile?.userTexts ?? []),
    assistantText: fromRows.assistantText ?? fromFile?.assistantText,
    fallbackProvider: input.fallbackProvider?.trim() || fromFile?.provider,
    fallbackModel: input.fallbackModel?.trim() || fromFile?.model,
  });
}
