import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createConfig } from "./config-factory.js";

describe("createConfig Pi MCP migration", () => {
  it("does not create a project .pi directory when storage preparation skips migration", () => {
    const root = mkdtempSync(join(tmpdir(), "zcode-storage-prep-"));
    try {
      mkdirSync(join(root, ".PiCode"));
      writeFileSync(
        join(root, ".PiCode", "config.json"),
        JSON.stringify({ mcp: { servers: { legacy: { command: "noop" } } } }),
      );
      createConfig({
        env: {},
        skipPiMcpMigration: true,
        skipUserConfig: true,
        workingDirectory: root,
      });
      assert.equal(existsSync(join(root, ".pi")), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
