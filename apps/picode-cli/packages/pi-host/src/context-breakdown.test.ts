import assert from "node:assert/strict";
import test from "node:test";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { readPiContextUsage } from "./context-breakdown.js";

const skills = [] as Skill[];

test("context breakdown keeps pi-cc categories and sums to the reported total", () => {
  const memory = "follow the house rules";
  const skill = "<skill><name>ponytail</name></skill>";
  const systemPrompt = [
    "You are pi.",
    `<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="AGENTS.md">\n${memory}\n</project_instructions>\n</project_context>`,
    `<skills>\n${skill}\n</skills>`,
  ].join("\n");
  const usage = readPiContextUsage(
    {
      systemPrompt,
      messages: [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "ok" },
            { type: "toolCall", name: "read", arguments: { path: "a.ts" } },
          ],
        },
        { role: "toolResult", content: [{ type: "text", text: "file body" }] },
        { role: "system", content: "do not count this twice" },
      ],
      getActiveToolNames: () => ["read"],
      getAllTools: () => [
        { name: "read", description: "Read a file", parameters: { type: "object" } },
        { name: "hidden", description: "no", parameters: {} },
      ],
      getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
      resourceLoader: { getSkills: () => ({ skills }) },
    },
    () => skill,
  );

  assert.ok(usage);
  const tokens = Object.fromEntries(usage.breakdown.map((item) => [item.source, item.tokens]));
  assert.equal(tokens.memory, Math.ceil(memory.length / 4));
  assert.ok((tokens.skills ?? 0) > 0);
  assert.ok((tokens.tools ?? 0) > 0);
  assert.equal(tokens.hidden, undefined);
  assert.ok((tokens.tool_results ?? 0) > 0);
  assert.ok((tokens.messages ?? 0) > 0);
  assert.equal(
    usage.breakdown.reduce((sum, item) => sum + (item.tokens ?? 0), 0),
    usage.used,
  );
  assert.equal(usage.used, 10_000);
});

test("a tiny provider total falls back to the content estimate", () => {
  const usage = readPiContextUsage(
    {
      systemPrompt: "x".repeat(400),
      messages: [],
      getActiveToolNames: () => [],
      getAllTools: () => [],
      getContextUsage: () => ({ tokens: 1, contextWindow: 1000, percent: 0.1 }),
      resourceLoader: { getSkills: () => ({ skills }) },
    },
    () => "",
  );
  assert.equal(usage?.used, 100);
});
