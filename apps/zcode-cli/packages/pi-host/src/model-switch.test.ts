import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakePiSession } from "./fake-session.js";
import { HostSessionRegistry } from "./session-registry.js";

async function createHosted() {
  const root = await mkdtemp(join(tmpdir(), "pi-host-model-"));
  const fakes = new Map<string, FakePiSession>();
  const registry = new HostSessionRegistry({
    storageRoot: root,
    nativeSessionsRoot: join(root, "pi-sessions"),
    createSession: async (input) => {
      const fake = new FakePiSession(input.sessionId, input.sessionFile);
      fake.currentModel = { providerId: "p", modelId: "a" };
      fakes.set(input.sessionId, fake);
      return fake;
    },
  });
  const hosted = await registry.create({ workspacePath: root });
  const fake = fakes.get(hosted.sessionId);
  assert.ok(fake);
  return { hosted, fake };
}

// 同值判定过去读投影 config：投影与 Pi 事实一旦脱节，真实切换会被当成 noop 永久吞掉
// （见 docs/specs/model-switch-runtime-ownership.md）。
test("投影与 Pi 事实脱节时仍然真的切模型", async () => {
  const { hosted, fake } = await createHosted();
  hosted.projector.setConfig({ provider: "p", model: "b", thought: "" });

  await hosted.setModel("p", "b");

  assert.deepEqual(fake.modelSwitchCalls, [{ provider: "p", modelId: "b" }]);
  assert.deepEqual(fake.currentModel, { providerId: "p", modelId: "b" });
  assert.equal(hosted.projector.getSnapshot().config.model, "b");
});

test("同 provider 同模型只切思考档位，不重复调用 setModel", async () => {
  const { hosted, fake } = await createHosted();
  hosted.projector.setConfig({ provider: "p", model: "a", thought: "low" });

  await hosted.setModel("p", "a", "high");

  assert.deepEqual(fake.modelSwitchCalls, []);
  assert.equal(hosted.projector.getSnapshot().config.thought, "high");
});

// 目标模型不在 Pi ModelRuntime 时不能再静默沿用旧模型：ACK 必须是失败。
test("目标模型不在 runtime 时 setModel 抛错", async () => {
  const { hosted, fake } = await createHosted();
  fake.acceptSetModel = false;

  await assert.rejects(
    () => hosted.setModel("p", "missing"),
    (error: Error & { reasonCode?: string }) => error.reasonCode === "model.notInRuntime",
  );
  assert.deepEqual(fake.currentModel, { providerId: "p", modelId: "a" });
});

test("getCurrentModelSelection 读 Pi 事实而不是投影", async () => {
  const { hosted } = await createHosted();
  hosted.projector.setConfig({ provider: "p", model: "b", thought: "high" });

  assert.deepEqual(hosted.getCurrentModelSelection(), {
    providerId: "p",
    modelId: "a",
    options: { reasoningLevel: "high" },
  });
});
