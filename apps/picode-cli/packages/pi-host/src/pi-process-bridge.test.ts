import assert from "node:assert/strict";
import test from "node:test";
import { createPiProcessBridge, toManagedProcessWorks } from "./pi-process-bridge.js";

test("managed process rows keep only live commands", () => {
  const works = toManagedProcessWorks([
    {
      id: "proc_1",
      name: "web",
      command: "pnpm dev",
      status: "running",
      startTime: 10,
      success: null,
      exitCode: null,
      endReason: null,
    },
    {
      id: "proc_2",
      name: "done",
      command: "pnpm test",
      status: "exited",
      startTime: 11,
      success: true,
      exitCode: 0,
      endReason: "exit",
    },
  ]);
  assert.deepEqual(works, [
    {
      workId: "pi-process:proc_1",
      kind: "bash",
      title: "web: pnpm dev",
      status: "running",
      startedAt: 10,
      cancellable: true,
      anchorRowId: null,
    },
  ]);
});

test("bridge lists, reads, and kills through the plugin bus", async () => {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const bus = {
    on(channel: string, handler: (data: unknown) => void) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
      return () => undefined;
    },
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
  };
  let killed = "";
  bus.on("processes:request:list", (payload) => {
    (payload as { reply: (rows: unknown[]) => void }).reply([
      {
        id: "proc_1",
        name: "web",
        command: "pnpm dev",
        status: "running",
        startTime: 10,
        success: null,
        exitCode: null,
        endReason: null,
      },
    ]);
  });
  bus.on("processes:request:get", (payload) => {
    (payload as { reply: (row: unknown) => void }).reply({
      id: "proc_1",
      name: "web",
      command: "pnpm dev",
      status: "running",
      startTime: 10,
      success: null,
      exitCode: null,
      endReason: null,
    });
  });
  bus.on("processes:request:combined_output", (payload) => {
    // 插件合同的 text 不含行尾换行，桥接必须自己补回。
    (payload as { reply: (lines: unknown) => void }).reply([
      { type: "stdout", text: "ready" },
      { type: "stderr", text: "warning" },
    ]);
  });
  bus.on("processes:request:log_files", (payload) => {
    (payload as { reply: (files: unknown) => void }).reply({ combinedFile: "combined.log" });
  });
  bus.on("processes:command:kill", (payload) => {
    const command = payload as { id: string; reply: (result: { ok: boolean }) => void };
    killed = command.id;
    command.reply({ ok: true });
  });

  const bridge = createPiProcessBridge();
  const seen: string[] = [];
  const factory = bridge.factories[0];
  if (!factory || typeof factory === "function") throw new Error("missing factory");
  factory.factory({ events: bus } as never);
  bridge.subscribe((works) => seen.push(works.map((work) => work.workId).join(",")));
  bus.emit("processes:changed", {});
  const output = await bridge.output("pi-process:proc_1");
  assert.equal(seen.at(-1), "pi-process:proc_1");
  assert.equal(output.kind, "output");
  if (output.kind === "output") assert.equal(output.output, "ready\nwarning");
  assert.equal(await bridge.kill("proc_1"), true);
  assert.equal(killed, "proc_1");
});
