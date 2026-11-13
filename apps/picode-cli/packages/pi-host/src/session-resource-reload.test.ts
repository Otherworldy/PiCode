import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createDelegateProvider } from "./model-delegate.js";
import { createSdkSessionFactory } from "./session-factory.js";

const RELOAD_FAILURE = "fault.command.sessionReloadFailed";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-sdk-reload-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests: unknown[][] = [];
  const provider = createDelegateProvider({
    stream: async function* ({ messages }) {
      requests.push(messages);
      yield { type: "text", text: "Fixture response" };
      yield { type: "done" };
    },
  });
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(provider.provider);
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  let paths: string[] = [];
  let fail = false;
  const failure = new Error("resource fixture unavailable");
  const sdkSessions: AgentSession[] = [];
  const reload = AgentSession.prototype.reload;
  t.mock.method(AgentSession.prototype, "reload", async function (this: AgentSession) {
    sdkSessions.push(this);
    return reload.call(this);
  });
  const session = await createSdkSessionFactory({
    agentDir,
    modelRuntime: runtime,
    skillPaths: () => {
      if (fail) throw failure;
      return paths;
    },
  })({
    sessionId: "reload-fixture",
    cwd: root,
    sessionFile: join(root, "session.jsonl"),
    loadExtensions: true,
    omitHostExtensions: true,
    checkPermission: async () => "allow",
  });
  t.after(() => session.dispose());
  assert.equal(await session.setModel?.(provider.model.provider, provider.model.id, "high"), true);
  assert.equal(typeof session.reloadResources, "function");
  return {
    session,
    requests,
    root,
    agentDir,
    failure,
    sdk: () => {
      const sdk = sdkSessions.at(-1);
      assert.ok(sdk);
      return sdk;
    },
    paths: (value: string[]) => {
      paths = value;
    },
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

test("SDK reload refreshes resources while preserving session, history, model, thought and queue modes", async (t) => {
  const f = await fixture(t);
  const { session } = f;
  await session.bindUi?.({});
  await session.prompt("Remember the initial history");
  await session.waitTurn?.();
  const before = {
    id: session.sessionId,
    file: session.sessionFile,
    model: session.currentModel,
    thought: session.thinkingLevel,
    tree: session.readTree?.(),
  };
  await session.reloadResources!();
  const sdk = f.sdk();
  const leaf = sdk.sessionManager.getLeafId();
  const messages = structuredClone(sdk.agent.state.messages);
  session.setSteeringMode?.("all");
  session.setFollowUpMode?.("one-at-a-time");
  session.setUiDesignMode?.(true);
  // Simulate settings being changed by another session while this one retains its live modes.
  await sdk.settingsManager.flush();
  await writeFile(
    join(f.agentDir, "settings.json"),
    JSON.stringify({
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      retry: { enabled: false },
    }),
  );
  const skillDir = join(f.root, "extra-skill");
  await mkdir(skillDir);
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: extra-skill\ndescription: Reloaded skill\n---\nNew skill\n",
  );
  f.paths([skillDir]);
  const promptsDir = join(f.agentDir, "prompts");
  await mkdir(promptsDir);
  await writeFile(join(promptsDir, "reload-prompt.md"), "Reloaded prompt");
  assert.ok(!session.listSkills?.().some((item) => item.name === "extra-skill"));
  await session.reloadResources!();
  assert.ok(session.listSkills?.().some((item) => item.name === "extra-skill"));
  assert.ok(session.listSlashCommands?.().some((item) => item.name === "reload-prompt"));
  assert.equal(session.sessionId, before.id);
  assert.equal(session.sessionFile, before.file);
  assert.deepEqual(session.currentModel, before.model);
  assert.equal(session.thinkingLevel, before.thought);
  assert.deepEqual(session.readTree?.(), before.tree);
  assert.equal(sdk.sessionManager.getLeafId(), leaf);
  assert.deepEqual(sdk.agent.state.messages, messages);
  assert.equal(sdk.steeringMode, "all");
  assert.equal(sdk.followUpMode, "one-at-a-time");
  await sdk.settingsManager.flush();
  const settings = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")) as {
    steeringMode: string;
    followUpMode: string;
  };
  assert.equal(settings.steeringMode, "one-at-a-time");
  assert.equal(settings.followUpMode, "all");
  assert.equal(session.isUiDesignMode?.(), true);
  session.setUiDesignMode?.(false);
  await session.prompt("Use the reloaded resources");
  await session.waitTurn?.();
  assert.match(JSON.stringify(f.requests.at(-1)), /extra-skill/);
  assert.match(JSON.stringify(f.requests.at(-1)), /Remember the initial history/);
  f.paths([]);
  await rm(skillDir, { recursive: true });
  await rm(promptsDir, { recursive: true });
  await session.reloadResources!();
  assert.ok(!session.listSkills?.().some((item) => item.name === "extra-skill"));
  assert.ok(!session.listSlashCommands?.().some((item) => item.name === "reload-prompt"));
  assert.match(await readFile(session.sessionFile!, "utf8"), /Remember the initial history/);
});

test("SDK reload failure poisons input until a successful retry and preserves queue modes across failures", async (t) => {
  const f = await fixture(t);
  const { session } = f;
  session.setSteeringMode?.("all");
  session.setFollowUpMode?.("one-at-a-time");
  await session.reloadResources!();
  const sdk = f.sdk();
  await sdk.settingsManager.flush();
  await writeFile(
    join(f.agentDir, "settings.json"),
    JSON.stringify({
      steeringMode: "one-at-a-time",
      followUpMode: "all",
      retry: { enabled: false },
    }),
  );
  f.fail(true);
  let reloadError: unknown;
  await assert.rejects(session.reloadResources!(), (error) => {
    reloadError = error;
    assert.equal((error as { reasonCode: string }).reasonCode, RELOAD_FAILURE);
    assert.equal((error as Error).cause, f.failure);
    return true;
  });
  assert.equal(sdk.steeringMode, "all");
  assert.equal(sdk.followUpMode, "one-at-a-time");
  await assert.rejects(session.prompt("blocked"), (error) => error === reloadError);
  await assert.rejects(session.steer("blocked"), (error) => error === reloadError);
  await assert.rejects(session.followUp("blocked"), (error) => error === reloadError);
  await assert.rejects(session.continueAfterError!(), (error) => error === reloadError);
  await assert.rejects(session.compact(), (error) => error === reloadError);
  assert.throws(
    () => session.captureAbandonedBranch!({ entryId: "entry" }),
    (error) => error === reloadError,
  );
  await assert.rejects(
    session.summarizeAbandonedBranch!({ entries: [] }),
    (error) => error === reloadError,
  );
  await assert.rejects(session.navigateTree!("entry"), (error) => error === reloadError);
  await assert.rejects(session.setModel!("fixture", "fixture"), (error) => error === reloadError);
  assert.throws(
    () => session.setThinkingLevel!("low"),
    (error) => error === reloadError,
  );
  assert.throws(
    () => session.setSteeringMode!("one-at-a-time"),
    (error) => error === reloadError,
  );
  assert.throws(
    () => session.setFollowUpMode!("all"),
    (error) => error === reloadError,
  );
  assert.throws(
    () => session.toolLoadout!.setActiveToolsByName([]),
    (error) => error === reloadError,
  );
  await sdk.settingsManager.flush();
  const settings = JSON.parse(await readFile(join(f.agentDir, "settings.json"), "utf8")) as {
    steeringMode: string;
    followUpMode: string;
  };
  assert.equal(settings.steeringMode, "one-at-a-time");
  assert.equal(settings.followUpMode, "all");
  assert.equal(f.requests.length, 0);
  f.fail(false);
  await session.reloadResources!();
  assert.equal(sdk.steeringMode, "all");
  assert.equal(sdk.followUpMode, "one-at-a-time");
  await session.prompt("Recovered");
  await session.waitTurn?.();
  assert.equal(f.requests.length, 1);
});
