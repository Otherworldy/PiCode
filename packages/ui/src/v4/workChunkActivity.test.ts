import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantWorkRow } from "./conversationTurnRenderUnits.js";
import { resolveWorkActivity, workActivityForToolName, workActivityPhraseKey } from "./workChunkActivity.js";

function toolRow(
  rowId: number,
  toolName: string,
  status: "inputStreaming" | "pendingApproval" | "running" | "success",
): AssistantWorkRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "toolCall",
    toolCallId: `call-${rowId}`,
    toolName,
    status,
    inputText: "",
  };
}

function reasoningRow(rowId: number, text: string): AssistantWorkRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "reasoning",
    text,
    state: "streaming",
  };
}

function textRow(rowId: number): AssistantWorkRow {
  return {
    rowId,
    turnId: "t1",
    createdAt: rowId,
    createdAtSeq: rowId,
    kind: "assistantText",
    text: "做完了",
    state: "complete",
  };
}

test("工具名按 dsh 的分类归一，大小写和分隔符都不影响", () => {
  assert.equal(workActivityForToolName("Read"), "read");
  assert.equal(workActivityForToolName("read_file"), "read");
  assert.equal(workActivityForToolName("Grep"), "search");
  assert.equal(workActivityForToolName("glob"), "search");
  assert.equal(workActivityForToolName("Write"), "write");
  assert.equal(workActivityForToolName("Edit"), "edit");
  assert.equal(workActivityForToolName("ApplyPatch"), "edit");
  assert.equal(workActivityForToolName("Bash"), "commands");
  assert.equal(workActivityForToolName("exec_command"), "commands");
  assert.equal(workActivityForToolName("WebSearch"), "webSearch");
  assert.equal(workActivityForToolName("web_fetch"), "webFetch");
  assert.equal(workActivityForToolName("Agent"), "subagents");
  assert.equal(workActivityForToolName("TodoWrite"), "plan");
  assert.equal(workActivityForToolName("AskUserQuestion"), "questions");
  assert.equal(workActivityForToolName("js"), "code");
  assert.equal(workActivityForToolName("Skill"), "skill");
  // 没登记的工具落到 tools，不会被说成某个具体动作。
  assert.equal(workActivityForToolName("ReadSessionContext"), "tools");
  assert.equal(workActivityForToolName("mcp__unknown__do"), "tools");
});

test("参数还在流时是准备态，开始执行后才是正在", () => {
  assert.deepEqual(resolveWorkActivity([toolRow(2, "Read", "inputStreaming")], {
    stageRunning: true,
  }), { activity: "read", preparing: true });
  assert.deepEqual(resolveWorkActivity([toolRow(2, "Read", "running")], {
    stageRunning: true,
  }), { activity: "read", preparing: false });
});

test("等审批报提问，不报工具动作", () => {
  assert.deepEqual(resolveWorkActivity([toolRow(2, "Bash", "pendingApproval")], {
    stageRunning: true,
  }), { activity: "questions", preparing: false });
});

test("还有工具在跑时，后面跟着的思考行不抢活动", () => {
  assert.deepEqual(
    resolveWorkActivity([toolRow(2, "Grep", "running"), reasoningRow(3, "再查一下")], {
      stageRunning: true,
    }),
    { activity: "search", preparing: false },
  );
});

test("空思考行不参与判断，工具动作不会被带成思考", () => {
  assert.deepEqual(
    resolveWorkActivity([toolRow(2, "Read", "success"), reasoningRow(3, "  ")], {
      stageRunning: true,
    }),
    { activity: "read", preparing: false },
  );
});

test("阶段还在跑但子工具已落定，仍报那个工具的动作", () => {
  assert.deepEqual(resolveWorkActivity([toolRow(2, "Read", "success")], {
    stageRunning: true,
  }), { activity: "read", preparing: false });
});

test("阶段已经过去时，落定的工具不再算当前活动", () => {
  assert.deepEqual(resolveWorkActivity([toolRow(2, "Read", "success")], {
    stageRunning: false,
  }), { activity: "thinking", preparing: false });
});

test("没有在跑的工具时回到思考或正文", () => {
  assert.deepEqual(resolveWorkActivity([reasoningRow(2, "想想")], { stageRunning: true }), {
    activity: "thinking",
    preparing: false,
  });
  assert.deepEqual(resolveWorkActivity([textRow(2)], { stageRunning: true }), {
    activity: "answer",
    preparing: false,
  });
});

test("process 通知当块尾时不算在写答案", () => {
  const notice: AssistantWorkRow = {
    rowId: 3,
    turnId: "t1",
    createdAt: 3,
    createdAtSeq: 3,
    kind: "assistantText",
    text: '<process_event type="lifecycle">\n  <summary>Process "dev" ended.</summary>\n</process_event>',
    state: "complete",
  };
  assert.deepEqual(resolveWorkActivity([textRow(2), notice], { stageRunning: true }), {
    activity: "thinking",
    preparing: false,
  });
});

test("一块里什么都没有时不给活动", () => {
  assert.equal(resolveWorkActivity([], { stageRunning: true }), null);
});

test("同一个块同一个工时算两次得到同一条文案", () => {
  const state = { activity: "read" as const, preparing: false };

  assert.equal(
    workActivityPhraseKey(state, { seed: "t1:chunk-1", elapsedMs: 9_000 }),
    workActivityPhraseKey(state, { seed: "t1:chunk-1", elapsedMs: 9_000 }),
  );
});

test("工时递进一个轮换周期就换一条，三个周期把三条跑完", () => {
  const state = { activity: "read" as const, preparing: false };
  const at = (elapsedMs: number) => workActivityPhraseKey(state, { seed: "t1", elapsedMs });

  assert.notEqual(at(0), at(8_000));
  assert.notEqual(at(8_000), at(16_000));
  assert.equal(new Set([at(0), at(8_000), at(16_000)]).size, 3);
});

test("不同块从不同的那条起头，跨对话看着不重复", () => {
  const state = { activity: "read" as const, preparing: false };
  const starts = new Set(
    ["t1", "t1:chunk-1", "t2", "t2:chunk-1", "t3", "t3:chunk-2"].map((seed) =>
      workActivityPhraseKey(state, { seed, elapsedMs: 0 }),
    ),
  );

  assert.ok(starts.size > 1, `所有块都从同一条起头：${[...starts].join(",")}`);
});

test("准备态只有一句，不参与轮换", () => {
  const state = { activity: "read" as const, preparing: true };

  assert.equal(workActivityPhraseKey(state, { seed: "t1", elapsedMs: 0 }), "chat.workChunk.preparing.read");
  assert.equal(
    workActivityPhraseKey(state, { seed: "t1", elapsedMs: 60_000 }),
    "chat.workChunk.preparing.read",
  );
});
