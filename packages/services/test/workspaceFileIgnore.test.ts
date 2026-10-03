import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME,
  loadWorkspaceFileSearchIgnoreRules,
  readWorkspaceFileSearchIgnore,
} from "../src/file/workspaceFileIgnore.js";

async function makeRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "picodeignore-"));
}

test("renames .zcodeignore to .picodeignore and keeps the rules", async () => {
  const root = await makeRoot();
  try {
    const legacy = join(root, LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME);
    await writeFile(legacy, "secret-dir/\n");
    const read = await readWorkspaceFileSearchIgnore(root);
    assert.equal(read.source, "file");
    assert.equal(read.content, "secret-dir/\n");
    assert.equal(
      await readFile(join(root, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME), "utf8"),
      "secret-dir/\n",
    );
    await assert.rejects(stat(legacy));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps .picodeignore when both names exist", async () => {
  const root = await makeRoot();
  try {
    await writeFile(join(root, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME), "from-new/\n");
    await writeFile(join(root, LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME), "from-old/\n");
    const read = await readWorkspaceFileSearchIgnore(root);
    assert.equal(read.content, "from-new/\n");
    assert.equal(
      await readFile(join(root, LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME), "utf8"),
      "from-old/\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates .picodeignore and not .zcodeignore", async () => {
  const root = await makeRoot();
  try {
    await writeFile(join(root, ".gitignore"), "foo/\n");
    const loaded = await loadWorkspaceFileSearchIgnoreRules(root);
    assert.equal(loaded.source, "created-from-gitignore");
    const content = await readFile(join(root, WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME), "utf8");
    assert.match(content, /^foo\/\n/);
    await assert.rejects(stat(join(root, LEGACY_WORKSPACE_FILE_SEARCH_IGNORE_FILE_NAME)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
