import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { getMentionGroupLimitForQuery } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

/** 输入到搜索请求之间的静默期。 */
const MENTION_QUERY_DEBOUNCE_MS = 200;

function mapWorkspaceFileToMentionItem(entry: WorkspaceFileEntry): MentionItem {
  return {
    id: `file:${entry.relativePath}`,
    category: "files",
    label: entry.name,
    description: entry.relativePath,
    value: entry.relativePath,
    // 文件 mention 的标准转译格式需要保持 `[filename](path)`，
    // 之前这里误把整条 relativePath 当成链接文本，导致发送后回显和复制内容都退化成“长路径做标题”。
    // 这里恢复为只用 basename 做 label，路径只放在链接目标里，和输入框 node 样式保持一致。
    markdown: buildFileMentionMarkdown(entry.relativePath, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path],
    data: {
      kind: entry.type,
      path: entry.path,
      relativePath: entry.relativePath,
    },
  };
}

export function useFileMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
  defaultPreviewLimit?: number,
): MentionCategoryResult {
  const { fileService } = useServices();
  const limit =
    getMentionGroupLimitForQuery(query, defaultPreviewLimit) ?? WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // 连接实例也属于作用域：相同路径的远程重连不能接纳旧 Host 的查询结果。
  const scope = useMemo(
    () => ({
      error: null as Error | null,
      /** 本次打开面板是否已做过一次强制重建索引。 */
      refreshed: false,
    }),
    [fileService, workspacePath, workspaceIdentity, enabled],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    entries: WorkspaceFileEntry[];
    loading: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    // 错误态等待面板/工作区/连接生命周期重置，避免 query 变化触发失败重试循环。
    if (!enabled || scope.error) return;
    let active = true;
    // 输入驱动的搜索必须节流：useDeferredValue 只解决渲染优先级，不节流请求。
    const timer = window.setTimeout(() => {
      // 面板打开后的第一次搜索强制重建索引：面板关闭期间新建的文件要能立刻被 @ 看到。
      // 之后只用 TTL 内缓存 —— 未命中绝不能再触发全量 DFS（37 万文件工作区实测 21.8s，
      // 且 refresh 会绕过 Host 侧 in-flight 去重，等于每个按键一轮全仓 readdir）。
      //
      // 标记必须在真正发出请求时才写：React StrictMode 会 mount → unmount → mount，
      // 若在 effect 同步体里置位，第一次的请求被 cleanup 取消、第二次反而认为「已刷新过」，
      // 开发模式下首屏永远拿不到强制刷新。
      const refresh = !scope.refreshed;
      setResult({ scope, query, limit, entries: [], loading: true, error: null });
      void (async () => {
        try {
          const entries = await fileService.searchWorkspaceFiles({
            rootPath: workspacePath,
            workspaceIdentity,
            query,
            limit,
            ...(refresh ? { refresh: true } : {}),
          });
          if (!active) return;
          // 只在成功后才算「这次面板已刷新过」：失败的 refresh 不能让后续输入失去补扫机会。
          if (refresh) scope.refreshed = true;
          setResult({ scope, query, limit, entries, loading: false, error: null });
        } catch (error) {
          if (!active) return;
          scope.error = error instanceof Error ? error : new Error(String(error));
          setResult({ scope, query, limit, entries: [], loading: false, error: scope.error });
        }
      })();
    }, MENTION_QUERY_DEBOUNCE_MS);
    // 查询、工作区、连接或面板生命周期变化都使已发出的异步响应失效。
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [enabled, fileService, workspacePath, workspaceIdentity, query, limit, scope]);

  const current =
    enabled && result?.scope === scope && result.query === query && result.limit === limit;
  // stale-while-revalidate：query 变了但新结果还没到时继续显示上一轮结果。
  // 否则每个按键后的 debounce 窗口里 items 会清空一次，面板闪成空白。
  const sameScope = enabled && result?.scope === scope && result.limit === limit;
  const items = useMemo(
    () => (sameScope ? result.entries.map(mapWorkspaceFileToMentionItem) : []),
    [sameScope, result],
  );
  return {
    items,
    loading: enabled && !scope.error && (!current || result.loading),
    error: enabled ? scope.error : null,
    emptyText,
    title,
  };
}
