import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ZCodeProtocolNdjsonConnection } from "./transport.js";

describe("MCP App NDJSON admission", () => {
  it("admits cancellation, close and another app while a real wire request is pending", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const received = Promise.withResolvers<void>();
    const order: string[] = [];
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        order.push(message.method);
        if (message.method === "mcp/uiCallTool") {
          entered.resolve();
          await finish.promise;
        }
        if (message.method === "mcp/uiCloseInstance") received.resolve();
        return { id: message.id, result: {} };
      },
    });
    transport.start();
    try {
      input.write(JSON.stringify({ id: 1, method: "mcp/uiCallTool" }) + "\n");
      await entered.promise;
      for (const [index, method] of [
        "mcp/uiValidateInstance",
        "mcp/uiCancelCall",
        "mcp/uiCloseInstance",
      ].entries())
        input.write(JSON.stringify({ id: index + 2, method }) + "\n");
      await received.promise;
      expect(order).toEqual([
        "mcp/uiCallTool",
        "mcp/uiValidateInstance",
        "mcp/uiCancelCall",
        "mcp/uiCloseInstance",
      ]);
    } finally {
      finish.resolve();
      input.end();
      await transport.waitForClose();
    }
  });

  it("preserves ordinary request order and starts app control only after earlier admission", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const controls = Promise.withResolvers<void>();
    const order: string[] = [];
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        order.push(message.method);
        if (message.method === "session/create") {
          started.resolve();
          await finish.promise;
        }
        if (message.method === "mcp/uiCancelCall") controls.resolve();
        return { id: message.id, result: {} };
      },
    });
    transport.start();
    input.write(
      '{"id":1,"method":"session/create"}\n{"id":2,"method":"mcp/uiCancelCall"}\n{"id":3,"method":"session/read"}\n',
    );
    await started.promise;
    await controls.promise;
    expect(order).toEqual(["session/create", "mcp/uiCancelCall"]);
    finish.resolve();
    input.end();
    await transport.waitForClose();
    expect(order).toEqual(["session/create", "mcp/uiCancelCall", "session/read"]);
  });

  it("admits settings catalog reads while a session command is still running", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const reads = Promise.withResolvers<void>();
    const order: string[] = [];
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        const action =
          "params" in message && message.params && typeof message.params === "object"
            ? (message.params as { action?: string }).action
            : undefined;
        const label = action ? `${message.method}:${action}` : message.method;
        order.push(label);
        if (message.method === "session/send") {
          started.resolve();
          await finish.promise;
        }
        if (label === "pi/plugins:search") reads.resolve();
        return { id: message.id, result: {} };
      },
    });
    transport.start();
    try {
      input.write(
        [
          JSON.stringify({ id: 1, method: "session/send" }),
          JSON.stringify({ id: 2, method: "pi/models", params: { action: "get" } }),
          JSON.stringify({ id: 3, method: "pi/plugins", params: { action: "list" } }),
          JSON.stringify({ id: 5, method: "pi/plugins", params: { action: "search" } }),
          JSON.stringify({ id: 4, method: "pi/plugins", params: { action: "checkUpdates" } }),
        ].join("\n") + "\n",
      );
      await started.promise;
      await reads.promise;
      expect(order).toEqual([
        "session/send",
        "pi/models:get",
        "pi/plugins:list",
        "pi/plugins:search",
      ]);
    } finally {
      finish.resolve();
      input.end();
      await transport.waitForClose();
    }
    expect(order).toEqual([
      "session/send",
      "pi/models:get",
      "pi/plugins:list",
      "pi/plugins:search",
      "pi/plugins:checkUpdates",
    ]);
  });
});

describe("NDJSON 字节边界", () => {
  it("中文被切在字节中间时不产生 U+FFFD", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received = Promise.withResolvers<string>();
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if ("method" in message && typeof message.method === "string") {
          received.resolve(message.method);
        }
        return undefined;
      },
    });
    transport.start();
    try {
      const method = "会话/发送中文";
      const bytes = Buffer.from(`${JSON.stringify({ id: 1, method })}\n`, "utf8");
      // 切点落在「会」字的 UTF-8 序列中间：toString("utf8") 会在这里产出 U+FFFD。
      const cut = bytes.indexOf(Buffer.from("会", "utf8")) + 1;
      expect(cut).toBeGreaterThan(0);
      input.write(bytes.subarray(0, cut));
      input.write(bytes.subarray(cut));
      await expect(received.promise).resolves.toBe(method);
    } finally {
      input.end();
    }
  });

  it("emoji 跨分片完好且不丢行", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const methods: string[] = [];
    const allReceived = Promise.withResolvers<void>();
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if ("method" in message && typeof message.method === "string") {
          methods.push(message.method);
          if (methods.length === 2) allReceived.resolve();
        }
        return undefined;
      },
    });
    transport.start();
    try {
      const payload = Buffer.from(
        `${JSON.stringify({ id: 1, method: "🎉first" })}\n${JSON.stringify({ id: 2, method: "second" })}\n`,
        "utf8",
      );
      // 每 3 字节喂一次，保证 emoji（4 字节）和中文都会被切开。
      for (let offset = 0; offset < payload.length; offset += 3) {
        input.write(payload.subarray(offset, Math.min(offset + 3, payload.length)));
      }
      await allReceived.promise;
      expect(methods).toEqual(["🎉first", "second"]);
    } finally {
      input.end();
    }
  });

  it("末尾无换行的残留行在 close 时仍被派发", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const received = Promise.withResolvers<string>();
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      async handleMessage(message) {
        if ("method" in message && typeof message.method === "string") {
          received.resolve(message.method);
        }
        return undefined;
      },
    });
    transport.start();
    input.write(JSON.stringify({ id: 1, method: "tail/中文" }));
    input.end();
    await expect(received.promise).resolves.toBe("tail/中文");
  });
});
