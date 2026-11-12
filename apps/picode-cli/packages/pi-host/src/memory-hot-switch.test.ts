import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakePiSession } from "./fake-session.js";
import { HostSessionRegistry } from "./session-registry.js";
import type { PiHostEvent } from "./types.js";

async function writeProjectSwitch(workspacePath: string, enabled: boolean): Promise<void> {
  await mkdir(join(workspacePath, ".pi"), { recursive: true });
  await writeFile(
    join(workspacePath, ".pi", "picode.json"),
    JSON.stringify({ features: { memory: enabled } }),
    "utf-8",
  );
}

/** 一轮真实的用户输入 + agent_end，让投影窗口里长出一条 turn。 */
function emitTurn(pi: FakePiSession, index: number, text: string): void {
  const events: PiHostEvent[] = [
    { type: "agent_start" },
    { type: "message_start", message: { role: "user", content: text, id: `u${index}` } },
    { type: "message_end", message: { role: "user", content: text, id: `u${index}` } },
    { type: "agent_end" },
  ];
  for (const event of events) pi.emit(event);
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();
  while (!check()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("memory switch is read per use, not from the session snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-memory-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await writeProjectSwitch(workspacePath, false);
  try {
    const pi = new FakePiSession("s");
    const registry = new HostSessionRegistry({
      storageRoot: root,
      nativeSessionsRoot: join(root, "pi-sessions"),
      createSession: async () => pi,
    });
    // 能力位为真、创建时开关为关：这正是“在已有会话里打开开关”的场景。
    const session = await registry.create({
      workspacePath,
      memoryEnabled: true,
      memoryEnabledAtCreation: false,
    });
    assert.equal(session.memoryEnabledAtCreation, false);
    assert.equal(await session.readMemoryEnabled(), false);

    await writeProjectSwitch(workspacePath, true);
    assert.equal(await session.readMemoryEnabled(), true);

    await writeProjectSwitch(workspacePath, false);
    assert.equal(await session.readMemoryEnabled(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sessions without the memory capability never read the project config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-memory-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await writeProjectSwitch(workspacePath, true);
  try {
    const pi = new FakePiSession("s");
    const registry = new HostSessionRegistry({
      storageRoot: root,
      nativeSessionsRoot: join(root, "pi-sessions"),
      createSession: async () => pi,
    });
    // 侧聊 / 远端：开关写着 true 也不生效。
    const session = await registry.create({ workspacePath });
    assert.equal(session.memoryCapable, false);
    assert.equal(await session.readMemoryEnabled(), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extraction starts on the next turns after enabling memory in a live session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-memory-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await writeProjectSwitch(workspacePath, false);
  const written = new Set<string>();
  const pollWritten = setInterval(() => {
    void readdir(join(workspacePath, ".pi", "memory"))
      .then((names) => {
        for (const name of names) written.add(name);
      })
      .catch(() => undefined);
  }, 10);
  try {
    const pi = new FakePiSession("s");
    Object.assign(pi, {
      currentModel: { providerId: "p", modelId: "m" },
      listModels: () => [{ providerId: "p", modelId: "m" }],
    });
    const prompts: string[] = [];
    const registry = new HostSessionRegistry({
      storageRoot: root,
      nativeSessionsRoot: join(root, "pi-sessions"),
      createSession: async () => pi,
      completeMemoryPrompt: async (request) => {
        prompts.push(request.prompt);
        return JSON.stringify({
          writes: [
            {
              file: "note.md",
              content: "---\nname: Note\ndescription: 记一条\ntype: fact\n---\n\nbody\n",
            },
          ],
          appends: [],
          deletes: [],
        });
      },
    });
    await registry.create({
      workspacePath,
      memoryEnabled: true,
      memoryEnabledAtCreation: false,
    });

    // 创建时开关为关：三轮过去也不抽取。
    for (let index = 0; index < 3; index += 1) {
      emitTurn(pi, index, `部署脚本改动需要重新生成 manifest ${index}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(prompts, []);

    // 会话不重建，只改项目配置：下一轮起就该抽取。
    await writeProjectSwitch(workspacePath, true);
    for (let index = 3; index < 6; index += 1) {
      emitTurn(pi, index, `部署脚本改动需要重新生成 manifest ${index}`);
    }
    await waitFor(() => prompts.length > 0);
    // 抽取 prompt 带当天日期，模型写 lastConfirmed 才有依据。
    assert.match(prompts[0] ?? "", /Today is \d{4}-\d{2}-\d{2} \(UTC\)/);
    // 落盘也要完成：开关不仅要放行调度，还要能真写进项目记忆目录。
    await waitFor(() => written.has("note.md"));
  } finally {
    clearInterval(pollWritten);
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty patch is a successful extraction and moves the cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-memory-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await writeProjectSwitch(workspacePath, true);
  try {
    const pi = new FakePiSession("s");
    Object.assign(pi, {
      currentModel: { providerId: "p", modelId: "m" },
      listModels: () => [{ providerId: "p", modelId: "m" }],
    });
    const prompts: string[] = [];
    const registry = new HostSessionRegistry({
      storageRoot: root,
      nativeSessionsRoot: join(root, "pi-sessions"),
      createSession: async () => pi,
      completeMemoryPrompt: async (request) => {
        prompts.push(request.prompt);
        // 前一段对话没有值得记的内容：模型返回空更新，这是合法结果。
        return "{}";
      },
    });
    await registry.create({ workspacePath, memoryEnabled: true, memoryEnabledAtCreation: true });

    for (let index = 0; index < 3; index += 1) {
      emitTurn(pi, index, `部署脚本改动需要重新生成 manifest ${index}`);
    }
    await waitFor(() => prompts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    for (let index = 3; index < 6; index += 1) {
      emitTurn(pi, index, `部署脚本改动需要重新生成 manifest ${index}`);
    }
    await waitFor(() => prompts.length === 2);
    // 游标已推进：第二轮不再重发上一段，只带新 turn。
    assert.doesNotMatch(prompts[1] ?? "", /manifest 0/);
    assert.doesNotMatch(prompts[1] ?? "", /manifest 2/);
    assert.match(prompts[1] ?? "", /manifest 5/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a truncated transcript is followed by an immediate continuation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-host-memory-"));
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath, { recursive: true });
  await writeProjectSwitch(workspacePath, true);
  try {
    const pi = new FakePiSession("s");
    Object.assign(pi, {
      currentModel: { providerId: "p", modelId: "m" },
      listModels: () => [{ providerId: "p", modelId: "m" }],
    });
    const prompts: string[] = [];
    const registry = new HostSessionRegistry({
      storageRoot: root,
      nativeSessionsRoot: join(root, "pi-sessions"),
      createSession: async () => pi,
      completeMemoryPrompt: async (request) => {
        prompts.push(request.prompt);
        return JSON.stringify({
          writes: [
            { file: "big.md", content: "---\nname: Big\ndescription: 大段\ntype: fact\n---\n" },
          ],
        });
      },
    });
    await registry.create({ workspacePath, memoryEnabled: true, memoryEnabledAtCreation: true });

    // 两个 turn 各 20k：预算 24k 只装得下第一个，第二个要等续抽。
    emitTurn(pi, 0, `部署 脚本 改动 ${"x".repeat(20_000)} FIRST`);
    emitTurn(pi, 1, `部署 脚本 改动 ${"y".repeat(20_000)} SECOND`);
    emitTurn(pi, 2, "部署 脚本 改动 收尾");

    // 不等下一个 3 轮 / 10 分钟闸门：本次结束后就该续抽被截断的尾段。
    await waitFor(() => prompts.length >= 2, 4000);
    assert.match(prompts[0] ?? "", /FIRST/);
    assert.doesNotMatch(prompts[0] ?? "", /SECOND/);
    assert.match(prompts[1] ?? "", /SECOND/);
    // 尾段抽完就停，不会空转。
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(prompts.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
