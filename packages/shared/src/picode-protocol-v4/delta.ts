import { mcpAppInstanceSchema } from "../mcp-apps/instance.js";
// ConversationDelta：快照增量与插件 UI 的 live-only 通知，操作集合封闭。
// 没有 row.inserted（中间插入）、没有 row.moved、没有字段级 JSON patch——
// 凡此模型表达不了的结构变化，服务端一律发 snapshot resync，刻意压缩客户端错误面。
import { z } from "zod";
import { streamablePathSchema } from "./core.js";
import { conversationRowSchema } from "./rows.js";
import { sharedContextImportStateSchema } from "./shared-context-import.js";
import {
  backgroundWorkSummarySchema,
  commandStateSummarySchema,
  goalStateSchema,
  inputRoutingSchema,
  pendingInteractionSchema,
  planStateSchema,
  queueStateSchema,
  sessionActionAvailabilitySchema,
  sessionConfigStateSchema,
  sessionControlSchema,
  sessionMetaStateSchema,
  sessionModelTransitionSchema,
  sessionUsageStateSchema,
  subagentProjectionStateSchema,
  workspaceHookAdmissionStateSchema,
} from "./snapshot.js";

// StatePatch：键级整体替换（Object.assign），键集合封闭。键内绝不深合并。
export const statePatchSchema = z.object({
  revision: z.number().optional(),
  control: sessionControlSchema.optional(),
  sharedContextImport: sharedContextImportStateSchema.optional(),
  availability: sessionActionAvailabilitySchema.optional(),
  inputRouting: inputRoutingSchema.optional(),
  meta: sessionMetaStateSchema.optional(),
  config: sessionConfigStateSchema.optional(),
  modelTransition: sessionModelTransitionSchema.nullable().optional(),
  usage: sessionUsageStateSchema.optional(),
  queue: queueStateSchema.optional(),
  pendingInteractions: z.array(pendingInteractionSchema).optional(),
  pendingCommands: z.array(commandStateSummarySchema).optional(),
  backgroundWorks: z.array(backgroundWorkSummarySchema).optional(),
  subagents: subagentProjectionStateSchema.optional(),
  goal: goalStateSchema.nullable().optional(),
  plan: planStateSchema.nullable().optional(),
  // 软门禁：null = pending 清零(提示条消失);对象 = 待审核状态更新。
  workspaceHookAdmission: workspaceHookAdmissionStateSchema.nullable().optional(),
  extensionWidgets: z
    .array(
      z.object({
        key: z.string().min(1),
        lines: z.array(z.string()),
        placement: z.enum(["aboveEditor", "belowEditor"]),
      }),
    )
    .optional(),
  extensionStatuses: z
    .array(
      z.object({
        key: z.string().min(1),
        text: z.string(),
      }),
    )
    .optional(),
  extensionNotice: z
    .object({
      id: z.string().min(1),
      command: z.string(),
      text: z.string(),
    })
    .nullable()
    .optional(),
  extensionCommandActive: z.boolean().optional(),
});
export type StatePatch = z.infer<typeof statePatchSchema>;

export const pluginUiResourceSubscriberSchema = z
  .object({
    scopeId: z.string(),
    generation: z.number().int().nonnegative(),
    instance: mcpAppInstanceSchema,
  })
  .strict();

export const conversationDeltaSchema = z.discriminatedUnion("op", [
  // 追加到尾部（99%）。
  z.object({ op: z.literal("row.appended"), row: conversationRowSchema }),
  // 按 rowId 整行替换（状态机迁移）。
  z.object({ op: z.literal("row.upserted"), row: conversationRowSchema }),
  // 删除该行及之后所有（edit/retry 分支）。作用于客户端已加载集合中所有 rowId >= fromRowId 的行。
  z.object({ op: z.literal("row.removed"), fromRowId: z.number() }),
  // 流式文本追加。仅允许作用于流式态行（服务端保证，客户端可断言）。
  z.object({
    op: z.literal("row.delta"),
    rowId: z.number(),
    path: streamablePathSchema,
    append: z.string(),
  }),
  z.object({ op: z.literal("state.updated"), patch: statePatchSchema }),
  // 插件 UI 订阅的 MCP 资源通知。live-only：不改快照（apply 为 no-op）、不进冷恢复；
  // renderer 按 subscribers 派发给对应沙箱实例。
  z.object({
    op: z.literal("pluginUi.resourceUpdated"),
    pluginId: z.string(),
    serverName: z.string(),
    uri: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  z.object({
    op: z.literal("pluginUi.resourceListChanged"),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  z.object({
    op: z.literal("pluginUi.instanceClosed"),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
  }),
  // App-Provided Tools 的"实例信箱"：模型发起的页面工具调用，live-only 投递给唯一实例（subscribers 恰一项）；
  // 渲染端认领后页面 tools/call，结果经 mcp/uiResolveAppToolCall 回传。不改快照、不进冷恢复。
  z.object({
    op: z.literal("pluginUi.appToolCall"),
    activity: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    pluginId: z.string(),
    serverName: z.string(),
    subscribers: z.array(pluginUiResourceSubscriberSchema),
    callId: z.string(),
    toolName: z.string(),
    arguments: z.record(z.string(), z.unknown()),
  }),
  // Plannotator 审查页。live-only：不进快照、不冷恢复；壳决定开内置浏览器还是系统浏览器。
  z.object({
    op: z.literal("embeddedBrowser.open"),
    url: z.string().min(1).max(4096),
  }),
]);
export type ConversationDelta = z.infer<typeof conversationDeltaSchema>;
export type PluginUiResourceDelta = Extract<
  ConversationDelta,
  { op: "pluginUi.resourceUpdated" | "pluginUi.resourceListChanged" }
>;
export type PluginUiAppToolCallDelta = Extract<ConversationDelta, { op: "pluginUi.appToolCall" }>;
/** 按沙箱实例投递的全部 live-only 增量。 */
export type PluginUiInstanceDelta =
  | Extract<ConversationDelta, { op: "pluginUi.instanceClosed" }>
  | PluginUiResourceDelta
  | PluginUiAppToolCallDelta;
