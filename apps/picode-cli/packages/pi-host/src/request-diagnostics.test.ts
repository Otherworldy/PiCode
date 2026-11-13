import assert from "node:assert/strict";
import test from "node:test";
import {
  createRequestDiagnosticsExtension,
  requestDiagnosticLogLevel,
  type RequestDiagnostic,
} from "./request-diagnostics.js";

async function harness() {
  let time = 0;
  const events: RequestDiagnostic[] = [];
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const extension = createRequestDiagnosticsExtension({
    onDiagnostic: (event) => events.push(event),
    now: () => time,
  });
  await extension.factory({
    on: (type: string, handler: (event: never, ctx: never) => unknown) => {
      handlers.set(type, handler);
    },
  } as never);
  const ctx = {
    sessionManager: { getSessionId: () => "session-test" },
    model: { provider: "mock", id: "selected", api: "openai-completions" },
  };
  return {
    events,
    at: (next: number) => {
      time = next;
    },
    async emit(type: string, event: object = {}) {
      return handlers.get(type)?.({ type, ...event } as never, ctx as never);
    },
  };
}
const image = { type: "image", mimeType: "image/png", data: "aGVsbG8=" };
const context = {
  messages: [{ role: "user", content: [{ type: "text", text: "敏感正文" }, image] }],
};
const message = { role: "assistant", stopReason: "stop" };

test("request diagnostics measures active image bytes and exact UTF8 payload without mutation", async () => {
  const h = await harness();
  await h.emit("context_with_system", context);
  const payload = {
    model: "physical",
    messages: [{ content: "多字节🙂", image }],
    secret: "credential",
  };
  const snapshot = structuredClone(payload);
  h.at(5);
  assert.equal(await h.emit("before_provider_request", { payload }), undefined);
  const start = h.events[0]!;
  assert.equal(start.phase, "prepared");
  assert.equal(start.contextImageCount, 1);
  assert.equal(start.contextImageBase64Bytes, 8);
  assert.equal(start.payloadJsonBytes, Buffer.byteLength(JSON.stringify(payload)));
  assert.deepEqual(payload, snapshot);
  h.at(15);
  await h.emit("after_provider_response", { status: 200, headers: { secret: "credential" } });
  h.at(20);
  await h.emit("provider_stream_event", {
    provider: "mock",
    api: "openai-completions",
    model: "physical",
    data: { secret: "credential" },
  });
  h.at(30);
  await h.emit("message_update", {
    message,
    assistantMessageEvent: { type: "thinking_delta", delta: "private" },
  });
  h.at(40);
  await h.emit("message_update", {
    message,
    assistantMessageEvent: { type: "text_delta", delta: "answer" },
  });
  h.at(80);
  const messageWithUsage = {
    ...message,
    usage: { input: 150, output: 25, cacheRead: 40, cacheWrite: 10 },
  };
  await h.emit("message_end", { message: messageWithUsage });
  const end = h.events[1]!;
  assert.equal(end.phase, "settled");
  assert.equal(end.responseHeadersMs, 10);
  assert.equal(end.firstProviderEventMs, 15);
  assert.equal(end.firstContentMs, 25);
  assert.equal(end.firstTextMs, 35);
  assert.equal(end.durationMs, 75);
  assert.equal(end.model, "physical");
  assert.equal(end.outcome, "completed");
  assert.deepEqual(end.usage, messageWithUsage.usage);
  assert.doesNotMatch(JSON.stringify(h.events), /敏感正文|credential|private|answer|aGVsbG8=/);
});

test("two calls and aborted/error attempts never reuse context or first event timestamps", async () => {
  const h = await harness();
  await h.emit("context_with_system", context);
  await h.emit("before_provider_request", { payload: {} });
  h.at(2);
  await h.emit("after_provider_response", { status: 200 });
  h.at(3);
  await h.emit("provider_stream_event", {
    provider: "mock",
    api: "openai-completions",
    model: "physical",
    data: {},
  });
  h.at(5);
  await h.emit("message_update", {
    message,
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
  });
  h.at(10);
  await h.emit("message_end", { message: { ...message, stopReason: "error" } });
  await h.emit("context_with_system", { messages: [] });
  h.at(20);
  await h.emit("before_provider_request", { payload: {} });
  h.at(40);
  await h.emit("message_end", { message: { ...message, stopReason: "aborted" } });
  await h.emit("agent_end");
  await h.emit("session_shutdown");
  assert.equal(h.events.length, 4);
  assert.equal(h.events[1]?.outcome, "error");
  assert.equal(h.events[3]?.outcome, "aborted");
  assert.equal(h.events[3]?.firstContentMs, undefined);
  assert.equal(h.events[3]?.firstTextMs, undefined);
  assert.equal(h.events[3]?.firstProviderEventMs, undefined);
  assert.equal(h.events[3]?.responseHeadersMs, undefined);
  assert.equal(h.events[3]?.contextImageCount, 0);
  assert.equal(h.events[3]?.requestIndex, 2);
});

test("unobserved network and unresolved shutdown do not invent completions", async () => {
  const h = await harness();
  await h.emit("context_with_system", context);
  await h.emit("message_end", { message });
  await h.emit("agent_end");
  assert.deepEqual(h.events, []);
  await h.emit("before_provider_request", { payload: {} });
  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.equal(h.events.length, 2);
  assert.equal(h.events[1]?.outcome, "shutdown");
});

test("a delegate without payload cannot donate context to a later request before agent_end", async () => {
  const h = await harness();
  await h.emit("context_with_system", context);
  await h.emit("message_end", { message });
  assert.deepEqual(h.events, []);
  await h.emit("before_provider_request", { payload: {} });
  await h.emit("after_provider_response", { status: 200 });
  await h.emit("provider_stream_event", {
    provider: "other",
    model: "physical",
    api: "mock",
    data: {},
  });
  await h.emit("message_update", {
    message,
    assistantMessageEvent: { type: "text_delta", delta: "hi" },
  });
  await h.emit("message_end", { message: { ...message, usage: { input: 3, output: 2 } } });
  const end = h.events[1]!;
  assert.equal(end.correlation, "missing_context");
  assert.equal(end.outcome, "unattributed");
  assert.equal(end.modelSource, "selection");
  assert.equal(end.model, "selected");
  for (const field of [
    "contextImageCount",
    "contextImageBase64Bytes",
    "contextMeasurementMs",
    "responseHeadersMs",
    "firstContentMs",
    "firstTextMs",
    "firstProviderEventMs",
    "durationMs",
    "usage",
  ] as const) {
    assert.equal(end[field], undefined, field);
  }
});

test("first content observes tool metadata before arguments and ignores empty starts", async () => {
  const call = { type: "toolCall", id: "read-call", name: "read", arguments: {} };
  const empty = { ...call, id: "", name: "" };
  for (const scenario of [
    { start: call, next: "toolcall_delta", delta: "{}", expected: 15 },
    { start: call, expected: 15 },
    { start: empty, next: "toolcall_delta", delta: "", expected: 35 },
    { start: empty, next: "toolcall_end", expected: 35 },
    { start: empty, expected: undefined },
  ]) {
    const h = await harness();
    await h.emit("context_with_system", { messages: [] });
    h.at(5);
    await h.emit("before_provider_request", { payload: {} });
    h.at(20);
    await h.emit("message_update", {
      message,
      assistantMessageEvent: {
        type: "toolcall_start",
        contentIndex: 0,
        partial: { ...message, content: [scenario.start] },
      },
    });
    if (scenario.next) {
      h.at(40);
      await h.emit("message_update", {
        message,
        assistantMessageEvent: {
          type: scenario.next,
          delta: scenario.delta,
          contentIndex: 0,
          partial: { ...message, content: [call] },
          toolCall: call,
        },
      });
    }
    h.at(60);
    await h.emit("message_end", { message });
    assert.equal(h.events[1]?.firstContentMs, scenario.expected, JSON.stringify(scenario));
    assert.equal(h.events[1]?.firstTextMs, undefined);
  }
});

test("cache warming overlap omits uncorrelatable timings and stale active-context counts", async () => {
  const h = await harness();
  await h.emit("context_with_system", context);
  await h.emit("before_provider_request", { payload: {} });
  h.at(5);
  await h.emit("after_provider_response", { status: 200 });
  await h.emit("cache_warming_decision", { action: "refresh" });
  await h.emit("before_provider_request", { payload: { max_tokens: 1 } });
  await h.emit("after_provider_response", { status: 200 });
  await h.emit("message_end", { message });
  assert.equal(h.events[1]?.outcome, "unattributed");
  assert.equal(h.events[1]?.contextImageCount, undefined);
  assert.equal(h.events[1]?.contextImageBase64Bytes, undefined);
  assert.equal(h.events[1]?.contextMeasurementMs, undefined);
  assert.equal(h.events[0]?.contextImageCount, 1);
  assert.equal(requestDiagnosticLogLevel(h.events[1]!), "info");
  assert.equal(h.events[1]?.responseHeadersMs, undefined);
  assert.equal(h.events[2]?.contextImageCount, undefined);
  assert.equal(h.events[3]?.durationMs, undefined);
  assert.equal(h.events[3]?.correlation, "cache_warming");
});

test("serialization and diagnostic callback failures cannot change provider execution", async () => {
  const h = await harness();
  const payload: Record<string, unknown> = {};
  payload.self = payload;
  await h.emit("before_provider_request", { payload });
  assert.equal(h.events[0]?.payloadJsonBytes, undefined);
  assert.equal(h.events[0]?.payloadMeasurement, "unserializable");
  const handlers = new Map<string, (event: never, ctx: never) => unknown>();
  const extension = createRequestDiagnosticsExtension({
    onDiagnostic: () => {
      throw new Error("logger");
    },
  });
  await extension.factory({
    on: (name: string, handler: (event: never, ctx: never) => unknown) => {
      handlers.set(name, handler);
    },
  } as never);
  assert.doesNotThrow(() =>
    handlers.get("before_provider_request")?.(
      { payload: {} } as never,
      {
        sessionManager: { getSessionId: () => "test" },
      } as never,
    ),
  );
});
