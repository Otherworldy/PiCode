import type { ZCodePluginsReferenceCatalogParams } from "@zcode/shared";

/** ZCode 插件协议已删除。对话引用不再向 Agent 要插件目录。 */
export async function requestPluginReferenceCatalog(
  _client: unknown,
  _params: ZCodePluginsReferenceCatalogParams,
) {
  return { authority: "workspace" as const, plugins: [] };
}
