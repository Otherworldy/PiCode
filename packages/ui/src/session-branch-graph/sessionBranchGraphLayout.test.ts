import { describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import {
  SESSION_BRANCH_GRAPH_NODE_HEIGHT,
  SESSION_BRANCH_GRAPH_NODE_WIDTH,
  buildSessionBranchGraph,
  buildSessionBranchGraphInputs,
  type SessionBranchGraphInput,
} from "./sessionBranchGraphLayout.js";

function session(
  taskId: string,
  overrides: Partial<SessionBranchGraphInput> = {},
): SessionBranchGraphInput {
  return {
    taskId,
    title: taskId,
    createdAt: 1,
    updatedAt: 1,
    deleted: false,
    ...overrides,
  };
}

describe("buildSessionBranchGraphInputs", () => {
  it("把已删除行标记为 deleted，并把分叉来源透传成父边", () => {
    const tasks = [
      { taskId: "child", title: "child", createdAt: 3, updatedAt: 4, forkedFromTaskId: "root" },
    ] as ZCodeTaskMeta[];
    const deleted = [
      { taskId: "root", title: "root", createdAt: 1, updatedAt: 2 },
    ] as ZCodeTaskMeta[];

    const inputs = buildSessionBranchGraphInputs({ tasks, deletedTasks: deleted });

    expect(inputs).toHaveLength(2);
    expect(inputs.find((input) => input.taskId === "root")?.deleted).toBe(true);
    expect(inputs.find((input) => input.taskId === "child")?.forkedFromTaskId).toBe("root");
  });

  it("同一 task 同时出现在两路分区时保留未删除的那一行", () => {
    const tasks = [{ taskId: "a", title: "live", createdAt: 1, updatedAt: 1 }] as ZCodeTaskMeta[];
    const deleted = [{ taskId: "a", title: "gone", createdAt: 1, updatedAt: 1 }] as ZCodeTaskMeta[];

    const inputs = buildSessionBranchGraphInputs({ tasks, deletedTasks: deleted });

    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.deleted).toBe(false);
    expect(inputs[0]?.title).toBe("live");
  });
});

describe("buildSessionBranchGraph", () => {
  it("单个会话只有自己的节点，没有连线", () => {
    const layout = buildSessionBranchGraph({
      sessions: [session("only")],
      focusTaskId: "only",
      showDeleted: true,
    });

    expect(layout.nodes).toHaveLength(1);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBe(SESSION_BRANCH_GRAPH_NODE_WIDTH + 56);
    expect(layout.height).toBe(SESSION_BRANCH_GRAPH_NODE_HEIGHT + 56);
  });

  it("范围只取聚焦会话所在的分叉树，不相连的家族不出现", () => {
    const sessions = [
      session("root", { createdAt: 1 }),
      session("child", { createdAt: 2, forkedFromTaskId: "root" }),
      session("sibling", { createdAt: 3, forkedFromTaskId: "root" }),
      session("other-root", { createdAt: 4 }),
      session("other-child", { createdAt: 5, forkedFromTaskId: "other-root" }),
    ];

    const layout = buildSessionBranchGraph({
      sessions,
      focusTaskId: "child",
      showDeleted: true,
    });

    expect(layout.nodes.map((node) => node.taskId).sort()).toEqual(["child", "root", "sibling"]);
    expect(layout.rootTaskIds).toEqual(["root"]);
  });

  it("父节点水平居中于子节点跨度", () => {
    const sessions = [
      session("root", { createdAt: 1 }),
      session("a", { createdAt: 2, forkedFromTaskId: "root" }),
      session("b", { createdAt: 3, forkedFromTaskId: "root" }),
    ];

    const layout = buildSessionBranchGraph({
      sessions,
      focusTaskId: "a",
      showDeleted: true,
    });

    const root = layout.nodes.find((node) => node.taskId === "root");
    const a = layout.nodes.find((node) => node.taskId === "a");
    const b = layout.nodes.find((node) => node.taskId === "b");
    expect(root?.left).toBeCloseTo(((a?.left ?? 0) + (b?.left ?? 0)) / 2);
  });

  it("隐藏已删除节点后，子节点改挂最近可见祖先并标为间接分叉", () => {
    const sessions = [
      session("root", { createdAt: 1 }),
      session("gone", { createdAt: 2, forkedFromTaskId: "root", deleted: true }),
      session("leaf", { createdAt: 3, forkedFromTaskId: "gone" }),
    ];

    const shown = buildSessionBranchGraph({
      sessions,
      focusTaskId: "leaf",
      showDeleted: true,
    });
    const hidden = buildSessionBranchGraph({
      sessions,
      focusTaskId: "leaf",
      showDeleted: false,
    });

    expect(shown.nodes).toHaveLength(3);
    expect(shown.edges.map((edge) => edge.indirect)).toEqual([false, false]);

    expect(hidden.nodes.map((node) => node.taskId).sort()).toEqual(["leaf", "root"]);
    expect(hidden.parentByTaskId.get("leaf")).toBe("root");
    expect(hidden.edges).toHaveLength(1);
    expect(hidden.edges[0]?.indirect).toBe(true);
  });

  it("父节点在数据里完全缺失时补一个已删除的占位节点", () => {
    const layout = buildSessionBranchGraph({
      sessions: [session("orphan", { createdAt: 9, forkedFromTaskId: "lost-parent" })],
      focusTaskId: "orphan",
      showDeleted: true,
    });

    const placeholder = layout.nodes.find((node) => node.taskId === "lost-parent");
    expect(placeholder?.placeholder).toBe(true);
    expect(placeholder?.deleted).toBe(true);
    expect(layout.parentByTaskId.get("orphan")).toBe("lost-parent");
    expect(layout.edges[0]?.indirect).toBe(false);
  });

  it("聚焦会话不在数据里时退化为全量布局并给出 focusMissing", () => {
    const layout = buildSessionBranchGraph({
      sessions: [session("root"), session("child", { createdAt: 2, forkedFromTaskId: "root" })],
      focusTaskId: "missing",
      showDeleted: true,
    });

    expect(layout.focusMissing).toBe(true);
    expect(layout.nodes).toHaveLength(2);
  });

  it("子节点按创建顺序排列", () => {    const sessions = [
      session("root", { createdAt: 1 }),
      session("later", { createdAt: 30, forkedFromTaskId: "root" }),
      session("earlier", { createdAt: 20, forkedFromTaskId: "root" }),
    ];

    const layout = buildSessionBranchGraph({
      sessions,
      focusTaskId: "root",
      showDeleted: true,
    });
    const ordered = layout.nodes
      .filter((node) => node.depth === 1)
      .sort((left, right) => left.left - right.left)
      .map((node) => node.taskId);

    expect(ordered).toEqual(["earlier", "later"]);
  });

  it("环状 forkedFromTaskId 不会递归爆栈，也不会给出空图", () => {
    const layout = buildSessionBranchGraph({
      sessions: [
        session("a", { createdAt: 1, forkedFromTaskId: "b" }),
        session("b", { createdAt: 2, forkedFromTaskId: "a" }),
      ],
      focusTaskId: "a",
      showDeleted: true,
    });

    expect(layout.nodes.map((node) => node.taskId).sort()).toEqual(["a", "b"]);
  });

  it("关闭占位父节点时，不把缺失父会话当成已删除", () => {
    const layout = buildSessionBranchGraph({
      sessions: [session("orphan", { createdAt: 9, forkedFromTaskId: "lost-parent" })],
      focusTaskId: "orphan",
      showDeleted: true,
      allowPlaceholderParents: false,
    });

    expect(layout.nodes.map((node) => node.taskId)).toEqual(["orphan"]);
    expect(layout.rootTaskIds).toEqual(["orphan"]);
  });
});
