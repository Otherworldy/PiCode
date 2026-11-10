// 后台子代理结算通知的结构化事实。拆成独立文件是因为 rows.ts 已到 max-lines 上限
// （与 toolDisplay.ts 同一先例）：assistantTextRowSchema 只需要 import 这一份 schema。
import { z } from "zod";

/**
 * 后台子代理结算通知附在 assistantText 行上的结构化元数据。
 *
 * 通知正文仍是模型可见的完整文本（带角色与状态头），这里再给一份，让 UI 的卡片
 * 摘要行与展开正文各自成文：卡片不重复正文开头那两行，正文也不必为了卡片把
 * 标题抠掉。代价是同一次结算多存一份正文（≤16KB）。
 */
export const subagentSettlementSchema = z.object({
  agent: z.string().trim().min(1),
  status: z.enum(["success", "failed", "cancelled"]),
  /** 子会话 id。缺席时卡片不给右侧入口，只保留展开正文。 */
  childSessionId: z.string().trim().min(1).optional(),
  /** 子代理报告正文，不含角色与状态头。 */
  text: z.string(),
});
export type SubagentSettlement = z.infer<typeof subagentSettlementSchema>;
