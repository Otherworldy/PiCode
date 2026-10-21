import type { ZCodeTaskMeta } from "@zcode/shared";

// 分支图谱是纯布局计算：输入 task 行，输出节点/连线坐标。组件只负责画和交互，
// 这样「可见性折叠、聚焦范围、占位父节点」这些规则可以单测覆盖。
export const SESSION_BRANCH_GRAPH_NODE_WIDTH = 184;
export const SESSION_BRANCH_GRAPH_NODE_HEIGHT = 62;

const SIBLING_GAP = 18;
const LEVEL_GAP = 84;
/** 多个互不相连的分叉家族之间的水平留白（正常只会有一个家族）。 */
const ROOT_GAP = 32;
const PADDING = 28;

export interface SessionBranchGraphInput {
  taskId: string;
  title: string;
  /** 用户分叉来源。子智能体、侧聊的 parentSessionId 不属于分叉关系，不进图谱。 */
  forkedFromTaskId?: string;
  createdAt: number;
  updatedAt: number;
  status?: ZCodeTaskMeta["status"];
  /** tasks-index 的删除 tombstone：会话本体已删除，只能看不能进。 */
  deleted: boolean;
  /** 未读标记：从图谱跳过去要顺手带上它，否则侧栏蓝点清不掉。 */
  unreadAt?: number;
  /** tombstone 也已不存在时按子节点合成的占位父节点，标题留空由 UI 兜底。 */
  placeholder?: boolean;
}

export interface SessionBranchGraphNode extends SessionBranchGraphInput {
  depth: number;
  left: number;
  top: number;
}

export interface SessionBranchGraphEdge {
  fromTaskId: string;
  toTaskId: string;
  /** 中间夹着被隐藏的已删除节点：真实分叉点不在图里，用虚线表达间接关系。 */
  indirect: boolean;
  path: string;
}

export interface SessionBranchGraphLayout {
  nodes: SessionBranchGraphNode[];
  edges: SessionBranchGraphEdge[];
  width: number;
  height: number;
  /** taskId → 可见父 taskId（已跳过被隐藏的已删除节点）。 */
  parentByTaskId: Map<string, string>;
  childIdsByTaskId: Map<string, string[]>;
  rootTaskIds: string[];
  /** 聚焦会话不在输入里：图仍然按全量画，由 UI 决定怎么提示。 */
  focusMissing: boolean;
}

/**
 * 把四路 task 分区投影成图谱输入。
 *
 * 已删除行单独传入：它们的会话本体已经删除，sessions-index 不会再有该行，
 * 只有 tasks-index tombstone 保留标题和分叉来源。
 */
export function buildSessionBranchGraphInputs(params: {
  tasks: readonly ZCodeTaskMeta[];
  deletedTasks: readonly ZCodeTaskMeta[];
}): SessionBranchGraphInput[] {
  const inputs = new Map<string, SessionBranchGraphInput>();
  const push = (task: ZCodeTaskMeta, deleted: boolean): void => {
    if (!task.taskId || inputs.has(task.taskId)) return;
    inputs.set(task.taskId, {
      taskId: task.taskId,
      title: task.title ?? "",
      forkedFromTaskId: task.forkedFromTaskId,
      createdAt: task.createdAt || 0,
      updatedAt: task.updatedAt || task.createdAt || 0,
      status: task.status,
      unreadAt: typeof task.unreadAt === "number" ? task.unreadAt : undefined,
      deleted,
    });
  };
  for (const task of params.tasks) push(task, false);
  for (const task of params.deletedTasks) push(task, true);
  return [...inputs.values()];
}

/**
 * 构建当前会话所在分叉树的布局。
 *
 * 范围：聚焦会话所在的整个分叉家族（爬回根节点后取全部后代），
 * 不相连的其它家族不参与，图谱规模由当前工作面决定而不是由整个 workspace 的会话总量决定。
 */
export function buildSessionBranchGraph(params: {
  sessions: readonly SessionBranchGraphInput[];
  focusTaskId: string | null;
  showDeleted: boolean;
  /**
   * 任意一路分区读取失败时必须关掉：此时「父会话缺失」分不清是已删除还是没读到，
   * 把活着的会话画成「已删除」比缺一个节点更糟。
   */
  allowPlaceholderParents?: boolean;
}): SessionBranchGraphLayout {
  const byId = new Map<string, SessionBranchGraphInput>();
  for (const session of params.sessions) {
    if (session.taskId) byId.set(session.taskId, session);
  }
  // 分叉来源在 tombstone 之外也不存在时补一个占位节点，否则整支分支会凭空失去起点。
  // 占位节点按「已删除」处理：只用于让子节点有归属，本身不可进入。
  // 先收集再写入：边迭代边插会改变 Map 的迭代集合。
  if (params.allowPlaceholderParents !== false) {
    const placeholders = new Map<string, SessionBranchGraphInput>();
    for (const session of byId.values()) {
      const parentId = session.forkedFromTaskId;
      if (!parentId || byId.has(parentId) || placeholders.has(parentId)) continue;
      placeholders.set(parentId, {
        taskId: parentId,
        title: "",
        createdAt: session.createdAt - 1,
        updatedAt: session.updatedAt - 1,
        deleted: true,
        placeholder: true,
      });
    }
    for (const [taskId, placeholder] of placeholders) byId.set(taskId, placeholder);
  }

  const focusMissing = Boolean(params.focusTaskId) && !byId.has(params.focusTaskId as string);
  const inScope = resolveScope(byId, params.focusTaskId);

  const visibleIds = new Set<string>();
  for (const taskId of inScope) {
    const session = byId.get(taskId);
    if (!session) continue;
    if (!params.showDeleted && session.deleted) continue;
    visibleIds.add(taskId);
  }

  const parentByTaskId = new Map<string, string>();
  const childIdsByTaskId = new Map<string, string[]>();
  const roots: string[] = [];
  for (const taskId of visibleIds) {
    const effectiveParentId = resolveVisibleParent(byId, visibleIds, taskId);
    if (effectiveParentId && visibleIds.has(effectiveParentId)) {
      parentByTaskId.set(taskId, effectiveParentId);
      const siblings = childIdsByTaskId.get(effectiveParentId);
      if (siblings) siblings.push(taskId);
      else childIdsByTaskId.set(effectiveParentId, [taskId]);
    } else {
      roots.push(taskId);
    }
  }

  const compare = (leftId: string, rightId: string): number => {
    const left = byId.get(leftId);
    const right = byId.get(rightId);
    const createdDiff = (left?.createdAt ?? 0) - (right?.createdAt ?? 0);
    if (createdDiff !== 0) return createdDiff;
    return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
  };
  roots.sort(compare);
  for (const childIds of childIdsByTaskId.values()) childIds.sort(compare);

  const leftById = new Map<string, number>();
  const depthById = new Map<string, number>();
  let cursor = 0;
  const place = (taskId: string, depth: number): void => {
    // 环状 forkedFromTaskId（异常数据）会自相引用：每个节点只排一次。
    if (depthById.has(taskId)) return;
    depthById.set(taskId, depth);
    const childIds = childIdsByTaskId.get(taskId) ?? [];
    if (childIds.length === 0) {
      leftById.set(taskId, cursor);
      cursor += SESSION_BRANCH_GRAPH_NODE_WIDTH + SIBLING_GAP;
      return;
    }
    const start = cursor;
    for (const childId of childIds) place(childId, depth + 1);
    const end = cursor - SIBLING_GAP;
    leftById.set(taskId, (start + end) / 2 - SESSION_BRANCH_GRAPH_NODE_WIDTH / 2);
  };
  for (const rootId of roots) {
    place(rootId, 0);
    cursor += ROOT_GAP;
  }
  // 环没有任何根，上面的循环一条也排不到；补排剩下的节点，不能给出空图。
  if (depthById.size < visibleIds.size) {
    const leftovers = [...visibleIds].filter((taskId) => !depthById.has(taskId)).sort(compare);
    for (const taskId of leftovers) {
      place(taskId, 0);
      cursor += ROOT_GAP;
    }
  }

  let maxDepth = 0;
  for (const depth of depthById.values()) maxDepth = Math.max(maxDepth, depth);

  const nodes: SessionBranchGraphNode[] = [];
  for (const [taskId, left] of leftById) {
    const session = byId.get(taskId);
    if (!session) continue;
    const depth = depthById.get(taskId) ?? 0;
    nodes.push({
      ...session,
      depth,
      left: left + PADDING,
      top: PADDING + depth * (SESSION_BRANCH_GRAPH_NODE_HEIGHT + LEVEL_GAP),
    });
  }
  nodes.sort((left, right) => left.top - right.top || left.left - right.left);

  const nodeById = new Map(nodes.map((node) => [node.taskId, node]));
  const edges: SessionBranchGraphEdge[] = [];
  for (const node of nodes) {
    const parentId = parentByTaskId.get(node.taskId);
    const parent = parentId ? nodeById.get(parentId) : undefined;
    if (!parent) continue;
    const fromX = parent.left + SESSION_BRANCH_GRAPH_NODE_WIDTH / 2;
    const fromY = parent.top + SESSION_BRANCH_GRAPH_NODE_HEIGHT;
    const toX = node.left + SESSION_BRANCH_GRAPH_NODE_WIDTH / 2;
    const toY = node.top;
    const dy = toY - fromY;
    edges.push({
      fromTaskId: parent.taskId,
      toTaskId: node.taskId,
      indirect: parent.taskId !== node.forkedFromTaskId,
      path:
        `M ${fromX} ${fromY} ` +
        `C ${fromX} ${round(fromY + dy * 0.55)}, ` +
        `${toX} ${round(toY - dy * 0.55)}, ${toX} ${toY}`,
    });
  }

  let maxRight = SESSION_BRANCH_GRAPH_NODE_WIDTH;
  for (const node of nodes) {
    maxRight = Math.max(maxRight, node.left + SESSION_BRANCH_GRAPH_NODE_WIDTH);
  }

  return {
    nodes,
    edges,
    width: maxRight + PADDING,
    height:
      PADDING * 2 +
      (maxDepth + 1) * SESSION_BRANCH_GRAPH_NODE_HEIGHT +
      maxDepth * LEVEL_GAP,
    parentByTaskId,
    childIdsByTaskId,
    rootTaskIds: roots,
    focusMissing,
  };
}

/** 聚焦会话所在的整个分叉家族：先向上爬到根，再取该根的全部后代。 */
function resolveScope(
  byId: ReadonlyMap<string, SessionBranchGraphInput>,
  focusTaskId: string | null,
): Set<string> {
  if (!focusTaskId || !byId.has(focusTaskId)) return new Set(byId.keys());
  // 只留祖先链会丢掉同源兄弟分支，而兄弟分支正是分叉树要回答的问题（哪些方案并行试过）。
  let rootId = focusTaskId;
  let parentId = byId.get(focusTaskId)?.forkedFromTaskId;
  let guard = 0;
  while (parentId && byId.has(parentId) && guard < 512) {
    rootId = parentId;
    parentId = byId.get(parentId)?.forkedFromTaskId;
    guard += 1;
  }

  const scope = new Set<string>([rootId]);
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const session of byId.values()) {
      if (session.forkedFromTaskId !== current || scope.has(session.taskId)) continue;
      scope.add(session.taskId);
      stack.push(session.taskId);
    }
  }
  return scope;
}

/** 跳过被隐藏的已删除节点，挂到最近的可见祖先；没有可见祖先时返回空。 */
function resolveVisibleParent(
  byId: ReadonlyMap<string, SessionBranchGraphInput>,
  visibleIds: ReadonlySet<string>,
  taskId: string,
): string | null {
  let parentId = byId.get(taskId)?.forkedFromTaskId;
  let guard = 0;
  while (parentId && !visibleIds.has(parentId) && guard < 512) {
    parentId = byId.get(parentId)?.forkedFromTaskId;
    guard += 1;
  }
  return parentId && visibleIds.has(parentId) ? parentId : null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
