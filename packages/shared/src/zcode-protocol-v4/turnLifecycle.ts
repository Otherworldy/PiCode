import { z } from "zod";
import { timestampSchema } from "./core.js";

/**
 * CLI 经 `v4/turn/lifecycle` 上送的轮次起止事实。
 *
 * 这不是遥测：`zcode-server-cli` 的 supervisor 用它统计运行中的会话数，据此在
 * 有任务运行时阻止 server 更新 / 卸载（`prepare-update`、`prepare-uninstall`、
 * `apply-update`）。事实只带归属与终态，不带正文、prompt、工具输入或 provider 地址。
 *
 * 该流只承载本进程 live 事件，不进入 topic snapshot / recovery，因此
 * `web-remote-replayable` 恢复链路不依赖它。
 */
const turnLifecycleFactBase = {
  version: z.literal(1),
  eventId: z.string().min(1),
  eventSeq: z.number().int().nonnegative(),
  occurredAt: timestampSchema,
  sessionId: z.string().min(1),
  turnId: z.string().min(1).optional(),
} as const;

export const turnLifecycleFactSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...turnLifecycleFactBase,
      kind: z.literal("turn.started"),
    })
    .strict(),
  z
    .object({
      ...turnLifecycleFactBase,
      kind: z.literal("turn.terminal"),
      status: z.enum(["success", "interrupted", "failed"]),
    })
    .strict(),
]);

export type TurnLifecycleFact = z.infer<typeof turnLifecycleFactSchema>;

/** 仅供 server 侧统计：该事实是否让会话进入 / 离开运行中集合。 */
export function readTurnActivityCountDelta(fact: TurnLifecycleFact): 1 | -1 | 0 {
  if (fact.kind === "turn.started") return 1;
  return fact.kind === "turn.terminal" ? -1 : 0;
}
