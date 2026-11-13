import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSdkSessionFactory } from "./session-factory.js";

test("extension initialization diagnostics fail reload and allow recovery after repair", async () => {
  const root = await mkdtemp(join(tmpdir(), "picode-reload-diagnostic-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const session = await createSdkSessionFactory({
    agentDir,
    stream: async function* () {
      yield { type: "done" };
    },
  })({
    sessionId: "reload-diagnostic",
    cwd: root,
    sessionFile: join(root, "session.jsonl"),
    loadExtensions: true,
    omitHostExtensions: true,
    checkPermission: async () => "allow",
  });
  try {
    const extensions = join(agentDir, "extensions");
    await mkdir(extensions);
    const file = join(extensions, "broken.js");
    await writeFile(
      file,
      "export default () => { throw new Error('fixture extension initialization failed'); };\n",
    );
    await assert.rejects(session.reloadResources!(), (error) => {
      assert.equal(
        (error as { reasonCode: string }).reasonCode,
        "fault.command.sessionReloadFailed",
      );
      assert.match((error as Error).message, /fixture extension initialization failed/);
      return true;
    });
    await assert.rejects(
      session.prompt("must stay blocked"),
      /fixture extension initialization failed/,
    );
    await writeFile(
      file,
      'export default pi => pi.registerCommand("repaired-extension", { handler: async () => {} });\n',
    );
    await session.reloadResources!();
    assert.ok(
      session.listSlashCommands?.().some((command) => command.name === "repaired-extension"),
    );
    assert.equal(await session.prompt("recovered after repair"), true);
    await session.waitTurn?.();
    await rm(file);
    await session.reloadResources!();
    assert.ok(
      !session.listSlashCommands?.().some((command) => command.name === "repaired-extension"),
    );
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
