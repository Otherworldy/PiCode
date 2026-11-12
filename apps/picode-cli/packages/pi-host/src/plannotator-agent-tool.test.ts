import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ensurePlannotatorAgentToolEnabled } from "./plannotator-agent-tool.js";

function homeWithConfig(config: string | undefined): { home: string; done: () => void } {
  const home = mkdtempSync(join(tmpdir(), "zcode-plannotator-"));
  if (config !== undefined) {
    mkdirSync(join(home, ".plannotator"), { recursive: true });
    writeFileSync(join(home, ".plannotator", "config.json"), config);
  }
  return { home, done: () => rmSync(home, { recursive: true, force: true }) };
}

test("the agent tool is turned on when nothing says otherwise", () => {
  const { home, done } = homeWithConfig(undefined);
  try {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(ensurePlannotatorAgentToolEnabled(env, home), true);
    assert.equal(env.PLANNOTATOR_AGENT_TOOL, "1");
  } finally {
    done();
  }
});

test("an explicit choice from the environment wins", () => {
  const { home, done } = homeWithConfig('{"agentTool": false}');
  try {
    const off: NodeJS.ProcessEnv = { PLANNOTATOR_AGENT_TOOL: "0" };
    assert.equal(ensurePlannotatorAgentToolEnabled(off, home), false);
    assert.equal(off.PLANNOTATOR_AGENT_TOOL, "0");
    const on: NodeJS.ProcessEnv = { PLANNOTATOR_AGENT_TOOL: "true" };
    assert.equal(ensurePlannotatorAgentToolEnabled(on, home), false);
    assert.equal(on.PLANNOTATOR_AGENT_TOOL, "true");
  } finally {
    done();
  }
});

test("turning the plugin tool off in its config is respected", () => {
  for (const config of ['{"agentTool": false}', '{"agentTool": "false"}', '{"agentTool": "0"}']) {
    const { home, done } = homeWithConfig(config);
    try {
      const env: NodeJS.ProcessEnv = {};
      assert.equal(ensurePlannotatorAgentToolEnabled(env, home), false, config);
      assert.equal(env.PLANNOTATOR_AGENT_TOOL, undefined, config);
    } finally {
      done();
    }
  }
});

test("a config that already asks for the tool is left alone", () => {
  for (const config of ['{"agentTool": true}', '{"agentTool": "1"}', "{}", "{ broken"]) {
    const { home, done } = homeWithConfig(config);
    try {
      const env: NodeJS.ProcessEnv = {};
      assert.equal(ensurePlannotatorAgentToolEnabled(env, home), true, config);
      assert.equal(env.PLANNOTATOR_AGENT_TOOL, "1", config);
    } finally {
      done();
    }
  }
});

test("a relocated data directory is read instead of the default one", () => {
  const { home, done } = homeWithConfig('{"agentTool": false}');
  const dataDir = mkdtempSync(join(tmpdir(), "zcode-plannotator-data-"));
  try {
    const env: NodeJS.ProcessEnv = { PLANNOTATOR_DATA_DIR: dataDir };
    // 挪走的目录里没有配置，默认目录里的那条就不该算数。
    assert.equal(ensurePlannotatorAgentToolEnabled(env, home), true);
    assert.equal(env.PLANNOTATOR_AGENT_TOOL, "1");
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    done();
  }
});
