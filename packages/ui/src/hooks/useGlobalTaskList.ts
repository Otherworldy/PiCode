import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type {
  WindowHostControllerTaskListItem,
  ZCodeTaskListKind,
  ZCodeTaskListWorkspaceScope,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";
import { selectWorkspaceZCodeState, useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { attachTaskListRowActivity } from "@/v4/taskListRowActivity.js";
import { stabilizeTaskListItems } from "@/v4/taskListItemStabilization.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import type { WindowControllerTaskListVersion } from "@/v4/windowControllerTaskListRegistry.js";

type GlobalTaskListItem = WindowHostControllerTaskListItem;

const subscribeToNothing = () => () => {};
const zeroRevision = () => 0;

function buildWorkspaceScopes(workspaceTabs: WorkspaceTabState[]): ZCodeTaskListWorkspaceScope[] {
  const scopes = new Map<string, ZCodeTaskListWorkspaceScope>();
  for (const tab of workspaceTabs) {
    const scope = {
      workspacePath: tab.workspacePath,
      ...(tab.workspaceIdentity ? { workspaceIdentity: tab.workspaceIdentity } : {}),
    };
    scopes.set(
      JSON.stringify([tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath]),
      scope,
    );
  }
  return Array.from(scopes.values());
}

export function useGlobalTaskList(params: {
  kind: ZCodeTaskListKind;
  workspaceTabs: WorkspaceTabState[];
  sortBy: "created" | "updated";
  searchQuery: string;
  expanded: boolean;
  collapsedLimit: number;
}) {
  const baseServices = useBaseWorkspaceServices();
  const controller = baseServices.windowControllerService;
  const controllerRegistry = useMemo(
    () => (controller ? getWindowControllerTaskListRegistry(controller) : null),
    [controller],
  );
  const controllerRevision = useSyncExternalStore(
    controllerRegistry?.subscribe ?? subscribeToNothing,
    controllerRegistry?.getRevision ?? zeroRevision,
    controllerRegistry?.getRevision ?? zeroRevision,
  );
  // 这两份签名在渲染体里每次都算（2 次 map + 2 次 localeCompare 排序 + 2 次 JSON 编码）。
  // useMemo 按 tabs 引用失效；路径不含 \u0000/\u0001，拼成字符串比 JSON.stringify 便宜。
  const workspaceSignature = useMemo(
    () =>
      params.workspaceTabs
        .map(
          (tab) => [tab.workspaceIdentity?.trim() || tab.workspacePath, tab.workspacePath] as const,
        )
        .sort(
          ([leftKey, leftPath], [rightKey, rightPath]) =>
            leftKey.localeCompare(rightKey) || leftPath.localeCompare(rightPath),
        )
        .map(([key, path]) => `${key.length}:${key}${path.length}:${path}`)
        .join(""),
    [params.workspaceTabs],
  );
  const workspaceSourceGenerationSignature = useMemo(
    () =>
      params.workspaceTabs
        .map(
          (tab) =>
            [
              tab.workspaceIdentity?.trim() || tab.workspacePath,
              tab.workspacePath,
              tab.remoteSessionId?.trim() || null,
            ] as const,
        )
        .sort(
          ([leftKey, leftPath, leftSession], [rightKey, rightPath, rightSession]) =>
            leftKey.localeCompare(rightKey) ||
            leftPath.localeCompare(rightPath) ||
            (leftSession ?? "").localeCompare(rightSession ?? ""),
        )
        .map(([key, path, session]) => {
          const sessionKey = session ?? "";
          return `${key.length}:${key}${path.length}:${path}${sessionKey.length}:${sessionKey}`;
        })
        .join(""),
    [params.workspaceTabs],
  );
  const workspaceScopes = useMemo(
    () => buildWorkspaceScopes(params.workspaceTabs),
    // workspaceSignature 是标准化后的 scope 值签名，避免父组件重建 tabs 数组时重复查询。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaceSignature],
  );
  // 这个 selector 在每次 store 更新时都会跑（包括每个流式 token）。原来做 sort + JSON.stringify
  // 是为了得到一个可比较的稳定签名 —— 用拼接代替，避免每次分配嵌套数组与 JSON 字符串。
  const taskListVersionSignature = useZCodeSessionStore((state) =>
    params.workspaceTabs
      .map((tab) => {
        const workspace = selectWorkspaceZCodeState(
          state,
          tab.workspacePath,
          tab.workspaceIdentity,
        );
        const key = tab.workspaceIdentity?.trim() || tab.workspacePath;
        const version = String(workspace.taskListVersion);
        return `${key.length}:${key}${version.length}:${version}`;
      })
      .sort()
      .join("\u0001"),
  );
  const [items, setItems] = useState<GlobalTaskListItem[]>([]);
  const itemsRef = useRef<GlobalTaskListItem[]>(items);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(workspaceScopes.length > 0);
  const requestSerialRef = useRef(0);
  const manualRefreshSerialRef = useRef(0);

  const query = useMemo(
    () => ({
      kind: params.kind,
      workspaceScopes,
      sortBy: params.sortBy,
      search: params.searchQuery.trim() || undefined,
      limit: params.expanded ? undefined : params.collapsedLimit,
    }),
    [
      params.collapsedLimit,
      params.expanded,
      params.kind,
      params.searchQuery,
      params.sortBy,
      workspaceScopes,
    ],
  );
  const queryKey = useMemo(() => JSON.stringify(query), [query]);

  const load = useCallback(
    async (version: WindowControllerTaskListVersion) => {
      const requestSerial = ++requestSerialRef.current;
      if (workspaceScopes.length === 0) {
        setItems([]);
        itemsRef.current = [];
        setTotal(0);
        setHasMore(false);
        setLoading(false);
        return;
      }
      if (!controllerRegistry) {
        // 原子切换后 base attachment 必须提供 Controller；缺失代表 Host/Renderer 版本不一致。
        logger.error("[useGlobalTaskList] window Host Controller channel unavailable");
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const result = await controllerRegistry.list(queryKey, version, query);
        if (requestSerialRef.current !== requestSerial) {
          return;
        }
        // Controller 的每个 activity 帧（运行中任务的 tool 调用等）都会让本 hook 重查，
        // 而 attachTaskListRowActivity 与 tasks-index join 每次都产生全新对象。下游（grouped 视图）
        // 只能按引用判等，于是整棵列表树换代重渲染并重测量虚拟器。这里与 sessions-index lane 同款
        // 逐条引用稳定化：内容等价复用旧对象，整表等价复用旧数组。
        const nextItems = stabilizeTaskListItems(
          itemsRef.current,
          result.items.map((item) =>
            item.activity ? attachTaskListRowActivity(item, item.activity) : item,
          ),
        );
        itemsRef.current = nextItems;
        setItems(nextItems);
        setTotal(result.total);
        setHasMore(result.hasMore);
      } catch (error) {
        if (requestSerialRef.current === requestSerial) {
          // Controller 查询失败时保留最后可信列表，避免单 source 异常清空其他 workspace。
          logger.error(`[useGlobalTaskList] Controller 加载 ${params.kind} 列表失败`, error);
        }
      } finally {
        if (requestSerialRef.current === requestSerial) {
          setLoading(false);
        }
      }
    },
    [controllerRegistry, params.kind, query, queryKey, workspaceScopes],
  );

  const refresh = useCallback(async () => {
    manualRefreshSerialRef.current += 1;
    await load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
      manualRefreshSerial: manualRefreshSerialRef.current,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  useEffect(() => {
    // 远程 workspace 从断开占位恢复为在线 session 时 identity/path 不变，
    // taskListVersion 也可能尚未变化，旧缓存因此永久保留连接前的空结果。remoteSessionId
    // 只作为 source 代际触发重查，不改变 workspaceIdentity 与 Controller 查询契约。
    void load({
      controllerRevision,
      taskListVersionSignature,
      workspaceSourceGenerationSignature,
    });
  }, [controllerRevision, load, taskListVersionSignature, workspaceSourceGenerationSignature]);

  const hasRemoteScope = params.workspaceTabs.some((tab) => Boolean(tab.workspaceIdentity));
  return {
    items,
    total,
    hasMore,
    loading,
    syncingRemoteWorkspaces: loading && hasRemoteScope,
    refresh,
  };
}
