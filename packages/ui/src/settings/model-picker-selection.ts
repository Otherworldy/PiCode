import type { ZCodePiModelsMutateResult } from "@zcode/shared";
// 仅类型导入：该模块会被 node --test 直接加载，运行时不能有跨文件依赖。
import type { CatalogModel } from "./provider-draft.js";

export type DiscoveredModel = NonNullable<ZCodePiModelsMutateResult["discovered"]>[number];

export type DiscoveredEntry = DiscoveredModel & { alreadyAdded: boolean };

/** 可添加项超过该阈值时不再默认全选，避免一次导入把模型菜单淹没。 */
export const PICKER_DEFAULT_CAP = 20;
export const PICKER_DEFAULT_CAP_COUNT = 5;

/**
 * 端点列表去重后逐项标注是否已在草稿中。
 * 已添加项保留在原位置而不是过滤掉，让用户看见「端点有、但我已经有了」。
 */
export function annotateDiscovered(
  discovered: readonly DiscoveredModel[],
  existingModels: readonly { id: string }[],
): DiscoveredEntry[] {
  const known = new Set(existingModels.map((model) => model.id));
  const seen = new Set<string>();
  const entries: DiscoveredEntry[] = [];
  for (const model of discovered) {
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    entries.push({ ...model, alreadyAdded: known.has(model.id) });
  }
  return entries;
}

export function defaultSelectedIds(entries: readonly DiscoveredEntry[]): {
  ids: string[];
  capped: boolean;
} {
  const addable = entries.filter((entry) => !entry.alreadyAdded).map((entry) => entry.id);
  if (addable.length <= PICKER_DEFAULT_CAP) return { ids: addable, capped: false };
  return { ids: addable.slice(0, PICKER_DEFAULT_CAP_COUNT), capped: true };
}

export function chosenFromDiscovered(
  entries: readonly DiscoveredEntry[],
  selectedIds: readonly string[],
): CatalogModel[] {
  const selected = new Set(selectedIds);
  return entries
    .filter((entry) => !entry.alreadyAdded && selected.has(entry.id))
    .map((entry) => defaultChosen(entry));
}

export type OfferedModel = {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
};

/**
 * discover 只回传 id / name / contextWindow? / maxTokens?，
 * 其余字段（思考档位、输入模态、协议）都走这里的默认值，导入后由用户在卡片里调整。
 */
export function defaultChosen(offered: OfferedModel): CatalogModel {
  return {
    id: offered.id,
    name: offered.name && offered.name !== offered.id ? offered.name : offered.id,
    contextWindow: offered.contextWindow ?? 128_000,
    maxTokens: offered.maxTokens ?? 8192,
    reasoning: true,
    thinkingLevels: ["off", "low", "medium", "high"],
    input: ["text"],
  };
}
