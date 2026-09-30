import assert from "node:assert/strict";
import test from "node:test";
import type { SessionTreeNodeView } from "@zcode/shared/zcode-protocol-v4";
import { sessionBranchTips } from "./sessionBranchTips.js";

function node(partial: Partial<SessionTreeNodeView> & Pick<SessionTreeNodeView, "id">): SessionTreeNodeView {
  return {
    parentId: null,
    role: "assistant",
    preview: partial.id,
    depth: 0,
    active: false,
    leaf: false,
    ...partial,
  };
}

test("a straight path is one branch", () => {
  const tips = sessionBranchTips([
    node({ id: "u", role: "user", preview: "hi" }),
    node({ id: "a", parentId: "u", preview: "hello", leaf: true, active: true }),
  ]);
  assert.deepEqual(tips.map((tip) => tip.id), ["a"]);
  assert.equal(tips[0]?.forkPreview, null);
  assert.equal(tips[0]?.current, true);
});

test("a label bookmark stays on its message", () => {
  const tips = sessionBranchTips([
    node({ id: "u", role: "user", preview: "hi" }),
    node({ id: "a", parentId: "u", preview: "hello", label: "main" }),
    node({ id: "mark", parentId: "a", role: "other", leaf: true, active: true }),
  ]);
  assert.deepEqual(tips.map((tip) => [tip.id, tip.current, tip.label]), [["a", true, "main"]]);
});

test("a side note on the current path stays deletable", () => {
  const tips = sessionBranchTips([
    node({ id: "u", role: "user", preview: "hi", active: true }),
    node({ id: "a", parentId: "u", preview: "main", active: true }),
    node({ id: "leaf", parentId: "a", preview: "now", leaf: true, active: true }),
    node({ id: "side", parentId: "u", role: "other", preview: "note" }),
  ]);
  assert.deepEqual(
    tips.map((tip) => [tip.id, tip.current]),
    [
      ["leaf", true],
      ["side", false],
    ],
  );
});

test("only the fork tips are listed", () => {
  const tips = sessionBranchTips([
    node({ id: "root", role: "user", preview: "hi" }),
    node({ id: "main-leaf", parentId: "root", preview: "目录", leaf: true, active: true }),
    node({ id: "side", parentId: "root", preview: "文件夹下有什么" }),
    node({ id: "side-leaf", parentId: "side", preview: "packages/ui" }),
  ]);
  assert.deepEqual(
    tips.map((tip) => [tip.id, tip.current, tip.forkPreview]),
    [
      ["main-leaf", true, "目录"],
      ["side-leaf", false, "文件夹下有什么"],
    ],
  );
});
