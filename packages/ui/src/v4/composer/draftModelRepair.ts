// 记住的模型可能在目录里改名或下线；Host 解析不到时派生一个回退值供展示与提交，
// 不回写草稿——草稿仍持有用户记住的原意，目录恢复后它自动重新生效。
// 只判定模型身份：档位是模型的附属配置，仍由用户显式选择（见 docs/specs/composer-model-selection-restore.md）。
import type { ModelSelection } from "@picode/shared";
import type { ModelSelectionView } from "@picode/services";

export function modelSelectionIdentity(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`;
}

function findModel(view: ModelSelectionView, selection: ModelSelection) {
  for (const provider of view.providers) {
    if (provider.providerId !== selection.providerId) continue;
    const model = provider.models.find((candidate) => candidate.modelId === selection.modelId);
    if (model) return model;
  }
  return undefined;
}

/** 目录里是否存在这个模型身份；不校验档位，也不做账号改写（改写由 Host 的 effectiveSelection 负责）。 */
export function isModelInView(view: ModelSelectionView, selection: ModelSelection): boolean {
  return findModel(view, selection) !== undefined;
}

/**
 * 决定是否派生回退值（回退规则唯一入口）。
 *
 * 只有 Host 已经对当前草稿选择给出「解析不到」的结论（`effectiveSelection` 为空）时才派生：
 * 视图还没就绪时它可能用另一个目录（例如尚未投影 Pi 目录的 registry 视图）冒充结论。
 * 已有会话必须等会话快照，否则会抢在会话真值之前用 Host 默认占位；等待首次分享导入的草稿
 * 由新任务规则初始化，不由这里填。
 */
export function deriveDraftModelFallback(input: {
  readonly view: ModelSelectionView | null;
  readonly current: ModelSelection | null | undefined;
  /** 草稿已初始化（有 `mode`）。 */
  readonly draftInitialized: boolean;
  readonly awaitingFirstImport: boolean;
  readonly isNewTask: boolean;
  readonly hasSessionConfig: boolean;
  readonly sessionConfigSelection?: ModelSelection | null;
}): ModelSelection | null {
  const { view } = input;
  // hostResolved: 视图已解析出当前选择（含账号改写），此时不得用默认值覆盖它。
  if (!view || view.effectiveSelection != null) return null;
  if (!input.draftInitialized || input.awaitingFirstImport) return null;
  if (!input.isNewTask && !input.hasSessionConfig) return null;
  return resolveRepairedDraftModelSelection({
    view,
    current: input.current,
    candidates: input.isNewTask
      ? [view.preferredSelection]
      : [input.sessionConfigSelection, view.preferredSelection],
  });
}

/**
 * 派生回退值：`current` 仍可解析 → null（尊重记住的选择）；否则按 `candidates` 顺序取第一个
 * 在视图里存在的值，档位不支持时只保留身份。全部候选不可用时返回 null——账号暂时不可用
 * 不等于用户选择失效，此时宁可什么都不显示。
 */
export function resolveRepairedDraftModelSelection(input: {
  readonly view: ModelSelectionView;
  readonly current: ModelSelection | null | undefined;
  readonly candidates: readonly (ModelSelection | null | undefined)[];
}): ModelSelection | null {
  const { view, current, candidates } = input;
  if (current && isModelInView(view, current)) return null;
  const tried = new Set<string>(current ? [modelSelectionIdentity(current)] : []);
  for (const candidate of candidates) {
    if (!candidate) continue;
    const identity = modelSelectionIdentity(candidate);
    if (tried.has(identity)) continue;
    tried.add(identity);
    const model = findModel(view, candidate);
    if (!model) continue;
    const reasoningLevel = candidate.options?.reasoningLevel;
    const keepLevel =
      reasoningLevel !== undefined &&
      model.config.optionSpecs.reasoningLevel.values.includes(reasoningLevel);
    return {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
      ...(keepLevel ? { options: { reasoningLevel } } : {}),
    };
  }
  return null;
}
