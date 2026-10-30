import assert from "node:assert/strict";
import test from "node:test";
import { chunkAssistantWorkRenderItems } from "./conversationAssistantWorkChunks.js";
import type { ConversationAssistantWorkRenderItem } from "./conversationAssistantWorkItems.js";

const text = (key: string, body = "正文") =>
  ({ kind: "row", key, row: { kind: "assistantText", rowId: 1, text: body } }) as unknown as
    ConversationAssistantWorkRenderItem;
const processEvent = (key: string) =>
  ({
    kind: "row",
    key,
    row: {
      kind: "assistantText",
      rowId: 3,
      text: '<process_event type="lifecycle">\n  <summary>Process "dev" failed.</summary>\n</process_event>',
    },
  }) as unknown as ConversationAssistantWorkRenderItem;
const tool = (key: string) =>
  ({ kind: "row", key, row: { kind: "toolCall", rowId: 2 } }) as unknown as
    ConversationAssistantWorkRenderItem;

test("空列表不产生块", () => {
  assert.deepEqual(chunkAssistantWorkRenderItems([]), []);
});

test("纯工具链聚成一块，读者不必滚过正文才能看工具", () => {
  const chunks = chunkAssistantWorkRenderItems([tool("a"), tool("b"), tool("c")]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.kind, "work");
  assert.equal(chunks[0]?.kind === "work" && chunks[0].items.length, 3);
});

test("正文切开工作块：两段工具各自成块", () => {
  const chunks = chunkAssistantWorkRenderItems([tool("a"), text("t1"), tool("b"), tool("c")]);
  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ["work", "text", "work"],
  );
  assert.equal(chunks[0]?.kind === "work" && chunks[0].items.length, 1);
  assert.equal(chunks[2]?.kind === "work" && chunks[2].items.length, 2);
});

test("正文开头的块不会把正文吞进限高容器", () => {
  const chunks = chunkAssistantWorkRenderItems([text("t1"), tool("a")]);
  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ["text", "work"],
  );
});

test("正文结尾时最后一块仍是工作块", () => {
  const chunks = chunkAssistantWorkRenderItems([tool("a"), text("t1")]);
  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ["work", "text"],
  );
});

test("连续正文各自成块，不合并", () => {
  const chunks = chunkAssistantWorkRenderItems([text("t1"), text("t2")]);
  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ["text", "text"],
  );
});

test("块 key 取首项 key，展开重渲染后身份不变", () => {
  const chunks = chunkAssistantWorkRenderItems([tool("a"), tool("b")]);
  assert.equal(chunks[0]?.key, "work:a");
});

test("process 通知不是正文，不能把工作块切成两段", () => {
  const chunks = chunkAssistantWorkRenderItems([tool("a"), processEvent("p1"), tool("b")]);
  assert.deepEqual(
    chunks.map((chunk) => chunk.kind),
    ["work"],
  );
  assert.equal(chunks[0]?.kind === "work" && chunks[0].items.length, 3);
});
