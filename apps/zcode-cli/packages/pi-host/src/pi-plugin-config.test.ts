import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listPiPluginConfigs, writePiPluginConfig } from "./pi-plugin-config.js";

test("pi plugin config edits top-level fields and leaves nested values alone", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-plugin-config-"));
  const dir = join(agentDir, "extensions", "pi-tool-display");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "config.json"),
    `${JSON.stringify({ enabled: false, previewLines: 4, search: { apiKey: "keep" } })}\n`,
  );

  const listed = await listPiPluginConfigs(agentDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.fields.find((field) => field.key === "enabled")?.value, false);
  assert.deepEqual(listed[0]?.skipped, ["search"]);

  await writePiPluginConfig("pi-tool-display", { enabled: true, previewLines: 8, extra: true }, agentDir);
  const saved = JSON.parse(await readFile(join(dir, "config.json"), "utf8")) as {
    enabled: boolean;
    previewLines: number;
    search: { apiKey: string };
    extra?: boolean;
  };
  assert.equal(saved.enabled, true);
  assert.equal(saved.previewLines, 8);
  assert.equal(saved.search.apiKey, "keep");
  assert.equal(saved.extra, undefined);
  await assert.rejects(() => writePiPluginConfig("../settings", { enabled: true }, agentDir));
});
