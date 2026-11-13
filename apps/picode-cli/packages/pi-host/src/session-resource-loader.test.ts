import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiProcessBridge } from "./pi-process-bridge.js";
import { planZcodePluginSession } from "./pi-plugins.js";
import { createSessionResourceLoader } from "./session-resource-loader.js";

async function skill(root: string, name: string) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${name}\n`,
  );
  return dir;
}

test("resource reload uses the latest install, removal, switches and forced paths", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-loader-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const pkg = join(root, "plugin");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(pkg)]);
  await skill(join(pkg, "skills"), "package-skill");
  await mkdir(join(pkg, "prompts"));
  await writeFile(join(pkg, "prompts", "package-prompt.md"), "Package prompt");
  await mkdir(join(pkg, "extensions"));
  await writeFile(
    join(pkg, "extensions", "plugin.js"),
    'export default pi => pi.registerCommand("package-command", {description:"Package", handler:async()=>{}});',
  );
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({
      name: "reload-fixture",
      pi: { extensions: ["extensions/plugin.js"], skills: ["skills"], prompts: ["prompts"] },
    }),
  );
  const settingsPath = join(agentDir, "settings.json");
  const switchesPath = join(root, "pi-plugin-switches.json");
  const id = `pkg:user:${pkg}`;
  const oldSkill = await skill(root, "old-extra");
  const newSkill = await skill(root, "new-extra");
  let extraSkills = [oldSkill];
  const loader = createSessionResourceLoader(
    {
      cwd,
      agentDir,
      settingsManager: SettingsManager.create(cwd, agentDir),
      systemPromptOverride: () => "Retained system prompt",
      appendSystemPromptOverride: () => ["Retained appended prompt"],
      extensionFactories: [
        (pi) => {
          pi.on("resources_discover", () => ({ skillPaths: [extraSkills[0]!] }));
        },
      ],
    },
    async () => {
      const plan = await planZcodePluginSession(cwd, agentDir, root);
      return {
        plan,
        loader: {
          additionalSkillPaths: [...extraSkills, ...plan.skillPaths],
          additionalExtensionPaths: plan.extensionPaths,
          additionalPromptTemplatePaths: plan.promptPaths,
        },
      };
    },
  );
  const names = () =>
    loader
      .getSkills()
      .skills.map((item) => item.name)
      .sort();
  const commands = () =>
    loader.getExtensions().extensions.flatMap((ext) => [...ext.commands.keys()]);
  const extend = () =>
    loader.extendResources({
      skillPaths: [
        {
          path: extraSkills[0]!,
          metadata: {
            source: "fixture",
            scope: "temporary",
            origin: "top-level",
          },
        },
      ],
    });
  await loader.reload();
  assert.deepEqual(names(), ["old-extra"]);

  await writeFile(settingsPath, JSON.stringify({ packages: [pkg] }));
  assert.deepEqual(names(), ["old-extra"]);
  await loader.reload();
  assert.deepEqual(names(), ["old-extra", "package-skill"]);
  assert.ok(commands().includes("package-command"));
  assert.ok(loader.getPrompts().prompts.some((item) => item.name === "package-prompt"));

  await writeFile(switchesPath, JSON.stringify({ [id]: false }));
  await loader.reload();
  extend(); // resources_discover must not resurrect disabled package resources.
  assert.deepEqual(names(), ["old-extra"]);
  assert.ok(!commands().includes("package-command"));
  assert.ok(!loader.getPrompts().prompts.some((item) => item.name === "package-prompt"));

  await writeFile(settingsPath, JSON.stringify({ packages: [{ source: pkg, autoload: false }] }));
  await writeFile(switchesPath, JSON.stringify({ [id]: true }));
  extraSkills = [newSkill];
  await loader.reload();
  extend();
  assert.deepEqual(names(), ["new-extra", "package-skill"]);
  assert.ok(commands().includes("package-command"));
  assert.ok(loader.getPrompts().prompts.some((item) => item.name === "package-prompt"));
  assert.equal(loader.getSystemPrompt(), "Retained system prompt");
  assert.deepEqual(loader.getAppendSystemPrompt(), ["Retained appended prompt"]);

  await writeFile(settingsPath, JSON.stringify({ packages: [] }));
  await writeFile(switchesPath, "{}");
  await rm(pkg, { recursive: true, force: true });
  await loader.reload();
  assert.deepEqual(names(), ["new-extra"]);
  assert.ok(!commands().includes("package-command"));
  assert.ok(!loader.getPrompts().prompts.some((item) => item.name === "package-prompt"));
});

test("resource reload invalidates extension factories updated at the same path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-updated-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extension = join(root, "extension.js");
  const writeVersion = (name: string) =>
    writeFile(
      extension,
      `export default pi => pi.registerCommand("${name}", { handler: async () => {} });`,
    );
  await writeVersion("original-version");
  const loader = createSessionResourceLoader(
    { cwd: root, agentDir: join(root, "agent"), settingsManager: SettingsManager.inMemory() },
    async () => ({ loader: { additionalExtensionPaths: [extension] } }),
  );
  const commands = () =>
    loader.getExtensions().extensions.flatMap((ext) => [...ext.commands.keys()]);
  await loader.reload();
  assert.deepEqual(commands(), ["original-version"]);
  await writeVersion("updated-version");
  await loader.reload();
  assert.deepEqual(commands(), ["updated-version"]);
});

test("resource reload keeps the previous plugin plan when the SDK loader rejects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-failed-plan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pkg = join(root, "plugin");
  await skill(join(pkg, "skills"), "package-skill");
  await writeFile(join(pkg, "package.json"), JSON.stringify({ pi: { skills: ["skills"] } }));
  const extraSkill = await skill(root, "extra-skill");
  const plan = {
    extensionPaths: [],
    skillPaths: [],
    promptPaths: [],
    disabled: new Set<string>(),
  };
  let nextPlan = plan;
  const loader = createSessionResourceLoader(
    {
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [pkg] }),
      noExtensions: true,
    },
    async () => ({ loader: {}, plan: nextPlan }),
  );
  await loader.reload();
  nextPlan = { ...plan, disabled: new Set([`pkg:user:${pkg}`]) };
  const failingReload = t.mock.method(DefaultResourceLoader.prototype, "reload", async () => {
    throw new Error("fixture loader failure");
  });
  await assert.rejects(loader.reload(), /fixture loader failure/);
  failingReload.mock.restore();
  const extend = () =>
    loader.extendResources({
      skillPaths: [
        {
          path: extraSkill,
          metadata: { source: "fixture", scope: "temporary", origin: "top-level" },
        },
      ],
    });
  const names = () =>
    loader
      .getSkills()
      .skills.map((item) => item.name)
      .sort();
  extend();
  assert.deepEqual(names(), ["extra-skill", "package-skill"]);
  await loader.reload();
  extend();
  assert.deepEqual(names(), ["extra-skill"]);
});

test("SDK reload reruns process bridge factories without duplicate subscriptions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-resource-processes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bridge = createPiProcessBridge();
  const agentDir = join(root, "agent");
  const settingsManager = SettingsManager.inMemory();
  let generation = 0;
  let listRequests = 0;
  let emitChange = () => {};
  const loader = createSessionResourceLoader(
    {
      cwd: root,
      agentDir,
      settingsManager,
      extensionFactories: [
        (pi) => {
          const id = String(++generation);
          emitChange = () => pi.events.emit("processes:changed", {});
          pi.events.on("processes:request:list", (data: { reply: (rows: unknown[]) => void }) => {
            listRequests++;
            data.reply([
              {
                id,
                name: "test",
                command: "fixture",
                status: "running",
                startTime: 1,
                success: null,
                exitCode: null,
                endReason: null,
              },
            ]);
          });
        },
        ...bridge.factories,
      ],
    },
    async () => undefined,
  );
  let seen: string[] = [];
  let notifications = 0;
  bridge.subscribe((works) => {
    notifications++;
    seen = works.map((work) => work.workId);
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    }),
  });
  t.after(() => session.dispose());
  const assertSingleRefresh = () => {
    const beforeRequests = listRequests;
    const beforeNotifications = notifications;
    emitChange();
    assert.equal(listRequests, beforeRequests + 1);
    assert.equal(notifications, beforeNotifications + 1);
    assert.deepEqual(seen, [`pi-process:${generation}`]);
  };
  assertSingleRefresh();
  for (let i = 0; i < 3; i++) {
    await session.reload();
    assert.equal(generation, i + 2);
    assertSingleRefresh();
  }
});
