import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listPiAgentExtensions, listPiAgentTools } from "./pi-agent-tools.js";

const CUSTOM_EXTENSION = `
export default function (pi) {
  pi.registerTool({
    name: "custom_lookup",
    label: "Custom lookup",
    description: "test tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
  });
}
`;

async function fixture(packages: string[]) {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-tools-"));
  const agent = join(root, "agent");
  const cwd = join(root, "proj");
  await mkdir(agent, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agent, "settings.json"), JSON.stringify({ packages }), "utf8");
  return { root, agent, cwd };
}

async function customPackage(source: string) {
  const packageDir = await mkdtemp(join(tmpdir(), "pi-agent-tools-pkg-"));
  await mkdir(join(packageDir, "extensions"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "probe-tools" }),
    "utf8",
  );
  await writeFile(join(packageDir, "extensions", "probe.ts"), source, "utf8");
  return packageDir;
}

test("catalog lists Pi builtins and marks their source", async () => {
  const { agent, cwd } = await fixture([]);
  const tools = await listPiAgentTools(cwd, agent);
  const names = tools.map((tool) => tool.name);
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
    assert.ok(names.includes(name), `missing ${name}`);
  }
  assert.equal(tools.find((tool) => tool.name === "read")?.source, "builtin");
  // 非 Windows 上 powershell 不暴露；Windows 上保留。
  assert.equal(names.includes("powershell"), process.platform === "win32");
});

test("catalog and extension map include tools registered by configured Pi packages", async () => {
  const packageDir = await customPackage(CUSTOM_EXTENSION);
  const { agent, cwd } = await fixture([packageDir]);

  const tools = await listPiAgentTools(cwd, agent);
  assert.equal(tools.find((tool) => tool.name === "custom_lookup")?.source, "extension");

  const extensions = await listPiAgentExtensions(cwd, agent);
  const owner = extensions.find((extension) => extension.tools.includes("custom_lookup"));
  assert.ok(owner);
  // 子会话直接拿这个 URL 当 additionalExtensionPaths。
  assert.ok(owner.path.startsWith("file://"));
});

test("catalog never offers dispatch or MCP tools to a child session", async () => {
  const packageDir = await customPackage(`
export default function (pi) {
  for (const name of ["subagent", "picode_subagent", "mcp__demo__search"]) {
    pi.registerTool({
      name,
      label: name,
      description: "test tool",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
    });
  }
}
`);
  const { agent, cwd } = await fixture([packageDir]);

  const names = (await listPiAgentTools(cwd, agent)).map((tool) => tool.name);
  assert.equal(names.includes("subagent"), false);
  assert.equal(names.includes("picode_subagent"), false);
  assert.equal(
    names.some((name) => name.startsWith("mcp__")),
    false,
  );
  const extensionTools = (await listPiAgentExtensions(cwd, agent)).flatMap(
    (extension) => extension.tools,
  );
  assert.equal(
    extensionTools.some((name) => name.startsWith("mcp__")),
    false,
  );
});
