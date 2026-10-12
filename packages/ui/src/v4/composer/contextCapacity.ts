/** 圆环总量。会话模型要等下一次提交才写入，切换后不能继续显示默认模型的快照容量。 */

export interface ContextCapacityModel {
  modelId: string;
  config: { properties?: { contextWindow?: number } };
}

export interface ContextCapacityProvider {
  providerId: string;
  models: readonly ContextCapacityModel[];
}

export function readSelectedModelContextWindow(
  providers: readonly ContextCapacityProvider[] | undefined,
  providerId: string | undefined,
  modelId: string | undefined,
): number | null {
  if (!providers || !providerId || !modelId) return null;
  const value = providers
    .find((provider) => provider.providerId === providerId)
    ?.models.find((model) => model.modelId === modelId)
    ?.config.properties?.contextWindow;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

export function resolveComposerContextCapacity(params: {
  providers?: readonly ContextCapacityProvider[];
  providerId?: string;
  modelId?: string;
  snapshotMaxTokens?: number | null;
}): number | null {
  const selected = readSelectedModelContextWindow(
    params.providers,
    params.providerId,
    params.modelId,
  );
  if (selected !== null) return selected;
  const snapshot = params.snapshotMaxTokens;
  if (typeof snapshot !== "number" || !Number.isFinite(snapshot) || snapshot <= 0) return null;
  return Math.floor(snapshot);
}
