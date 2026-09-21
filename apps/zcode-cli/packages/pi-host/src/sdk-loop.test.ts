import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSdkSessionFactory } from "./session-factory.js";
import type { PiHostEvent } from "./types.js";

function waitFor(
  events: PiHostEvent[],
  predicate: (event: PiHostEvent) => boolean,
  timeoutMs = 20_000,
): Promise<PiHostEvent> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = events.find(predicate);
      if (hit) {
        clearInterval(timer);
        resolve(hit);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(
            `timeout waiting for event; saw ${events.map((event) => event.type).join(",")}`,
          ),
        );
      }
    }, 20);
  });
}

test("pi sdk agent loop: prompt \u2192 read \u2192 text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-pi-loop-"));
  try {
    await writeFile(join(dir, "hello.txt"), "hello from pi\n");
    const factory = createSdkSessionFactory({
      agentDir: join(dir, "agent"),
      stream: async function* ({ messages }) {
        const hasToolResult = messages.some(
          (message) =>
            Boolean(message) &&
            typeof message === "object" &&
            "role" in message &&
            (message as { role?: string }).role === "toolResult",
        );
        if (!hasToolResult) {
          yield {
            type: "tool_call",
            id: "call1",
            name: "read",
            arguments: { path: "hello.txt" },
          };
          yield { type: "done" };
          return;
        }
        yield { type: "text", text: "hello from pi" };
        yield { type: "done" };
      },
    });
    const session = await factory({
      sessionId: "loop1",
      cwd: dir,
      sessionFile: join(dir, "session.jsonl"),
      loadExtensions: false,
      checkPermission: async () => "allow",
    });
    const events: PiHostEvent[] = [];
    session.subscribe((event) => {
      events.push(event);
    });
    const accepted = await session.prompt("Read hello.txt and quote it.");
    assert.equal(accepted, true);
    await waitFor(events, (event) => event.type === "tool_execution_end");
    await waitFor(events, (event) => event.type === "agent_end" || event.type === "agent_settled");
    const tool = events.find((event) => event.type === "tool_execution_end");
    assert.equal(tool && tool.type === "tool_execution_end" ? tool.toolName : "", "read");
    assert.equal(tool && tool.type === "tool_execution_end" ? Boolean(tool.isError) : true, false);
    const text = events
      .filter(
        (event) =>
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta",
      )
      .map((event) =>
        event.type === "message_update" && event.assistantMessageEvent.type === "text_delta"
          ? event.assistantMessageEvent.delta
          : "",
      )
      .join("");
    assert.match(text, /hello from pi/);
    session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
