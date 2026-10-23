import {
  EMPTY_PLUGIN_UI_INSTANCE_DERIVATION,
  type PluginUiInstanceDerivation,
  type PluginUiRowDisposition,
} from "../domain/pluginUiInstancePolicy.js";

/**
 * 每个会话最近一次由时间线推导出的逻辑 UI 裁决（renderer 内存）。时间线在 effect 里写入，
 * 工具卡片按 (sessionKey, toolCallId) 读自己的裁决（是否被替代、是否强制常驻）；不持有任何沙箱状态。
 */
const derivations = new Map<string, PluginUiInstanceDerivation>();
const listeners = new Set<() => void>();

/**
 * 会话数上限：时间线每帧都会写入本会话的推导，已关闭会话的记录不会被清除，
 * 而每条记录持有整份 byToolCallId 表。超限时从最旧会话开始淘汰；
 * 活跃会话因每次写入都落到 Map 末尾而不会被误淘汰。
 */
const MAX_DERIVATION_SESSIONS = 24;

export function setPluginUiInstanceDerivation(
  sessionKey: string,
  derivation: PluginUiInstanceDerivation,
): void {
  if (derivations.get(sessionKey) === derivation) return;
  derivations.delete(sessionKey);
  derivations.set(sessionKey, derivation);
  while (derivations.size > MAX_DERIVATION_SESSIONS) {
    const oldestKey = derivations.keys().next();
    if (oldestKey.done) {
      break;
    }
    derivations.delete(oldestKey.value);
  }
  for (const listener of listeners) listener();
}

export function getPluginUiRowDisposition(
  sessionKey: string,
  toolCallId: string,
): PluginUiRowDisposition | undefined {
  return (derivations.get(sessionKey) ?? EMPTY_PLUGIN_UI_INSTANCE_DERIVATION).byToolCallId[
    toolCallId
  ];
}

export function subscribePluginUiInstances(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试用：清空全部记录。 */
export function resetPluginUiInstancesForTest(): void {
  derivations.clear();
  listeners.clear();
}
