// 子智能体工具清单：设置页给内置角色勾工具时的候选项。
// workspace 级、无会话，照 skills/referenceCatalog 的先例每次现扫，不缓存。
import { zcodeAgentToolCatalogParamsSchema, type ZCodeAgentToolCatalogResult } from "@zcode/shared";
import { listPiAgentTools } from "@zcode/pi-host";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

export async function getAgentToolCatalog(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeAgentToolCatalogResult> {
  const params = parseParams(zcodeAgentToolCatalogParamsSchema, rawParams);
  return { tools: await listPiAgentTools(params.workspace.workspacePath) };
}
