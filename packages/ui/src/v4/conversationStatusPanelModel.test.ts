import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationStatusPanelModel,
  planFromPlannotatorProgress,
} from "./conversationStatusPanelModel.js";

test("plannotator progress widget fills the todo list when plan is empty", () => {
  const widgets = [
    {
      key: "plannotator-progress",
      lines: ["☑ 画背景", "☐ 画自行车", "☐ 画鹈鹕"],
    },
  ];
  const parsed = planFromPlannotatorProgress(widgets);
  assert.deepEqual(
    parsed?.items.map((item) => [item.content, item.status]),
    [
      ["画背景", "completed"],
      ["画自行车", "inProgress"],
      ["画鹈鹕", "pending"],
    ],
  );
  const model = buildConversationStatusPanelModel({ extensionWidgets: widgets });
  assert.equal(model.plan?.completedCount, 1);
  assert.equal(model.plan?.totalCount, 3);
  const kept = buildConversationStatusPanelModel({
    extensionWidgets: widgets,
    plan: {
      updatedAt: 1,
      items: [{ id: "todo-1", content: "旧 TodoWrite", status: "pending" }],
    },
  });
  assert.equal(kept.plan?.items[0]?.content, "旧 TodoWrite");
});
