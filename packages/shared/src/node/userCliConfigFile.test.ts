import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { updateJsonConfigFile, userCliConfigFilePath } from "./userCliConfigFile.js";

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "picode-cli-config-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("userCliConfigFilePath resolves under <home>/.PiCode/cli", () => {
  assert.equal(
    userCliConfigFilePath("/home/tester"),
    join("/home/tester", ".PiCode", "cli", "config.json"),
  );
});

test("concurrent read-modify-write from four writers keeps every key", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");
    await writeFile(file, "{}\n", "utf-8");

    const perWriter = 8;
    const tasks: Promise<unknown>[] = [];
    for (let index = 0; index < perWriter; index += 1) {
      // 四个写者各改自己那一块，模拟 skills / command / mcp / plugins 并发。
      tasks.push(
        updateJsonConfigFile(file, (config) => ({
          ...config,
          skills: { ...(config.skills as object), [`skill-${index}`]: { enable: false } },
        })),
      );
      tasks.push(
        updateJsonConfigFile(file, (config) => ({
          ...config,
          command: { ...(config.command as object), [`cmd-${index}`]: { enable: false } },
        })),
      );
      tasks.push(
        updateJsonConfigFile(file, (config) => ({
          ...config,
          mcp: { ...(config.mcp as object), [`server-${index}`]: { url: "x" } },
        })),
      );
      tasks.push(
        updateJsonConfigFile(file, (config) => {
          const plugins = (config.plugins as { dirs?: string[] } | undefined) ?? {};
          return {
            ...config,
            plugins: { ...plugins, dirs: [...(plugins.dirs ?? []), `/p${index}`] },
          };
        }),
      );
    }
    await Promise.all(tasks);

    const merged = JSON.parse(await readFile(file, "utf-8")) as {
      skills?: Record<string, unknown>;
      command?: Record<string, unknown>;
      mcp?: Record<string, unknown>;
      plugins?: { dirs?: string[] };
    };
    assert.equal(Object.keys(merged.skills ?? {}).length, perWriter);
    assert.equal(Object.keys(merged.command ?? {}).length, perWriter);
    assert.equal(Object.keys(merged.mcp ?? {}).length, perWriter);
    assert.equal((merged.plugins?.dirs ?? []).length, perWriter);
  });
});

test("readers never observe a truncated file while writes are in flight", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");
    await writeFile(file, "{}\n", "utf-8");

    let parsing = true;
    let failures = 0;
    const reader = (async () => {
      while (parsing) {
        try {
          JSON.parse(await readFile(file, "utf-8"));
        } catch {
          failures += 1;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
    })();

    for (let index = 0; index < 30; index += 1) {
      await updateJsonConfigFile(file, (config) => ({ ...config, counter: index }));
    }
    parsing = false;
    await reader;
    assert.equal(failures, 0);
  });
});

test("build returning null skips the write", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");
    await writeFile(file, `${JSON.stringify({ plugins: { dirs: ["/a"] } })}\n`, "utf-8");
    const before = await stat(file);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const wrote = await updateJsonConfigFile(file, () => null);

    assert.equal(wrote, false);
    assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  });
});

test("build returning undefined is treated as skip, not written as the string 'undefined'", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");
    await writeFile(file, "{}\n", "utf-8");

    const wrote = await updateJsonConfigFile(file, () => undefined);

    assert.equal(wrote, false);
    assert.deepEqual(JSON.parse(await readFile(file, "utf-8")), {});
  });
});

test("corrupt JSON rejects and leaves the file untouched", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");
    const broken = "{ this is not json";
    await writeFile(file, broken, "utf-8");

    await assert.rejects(() => updateJsonConfigFile(file, (config) => ({ ...config, x: 1 })));
    assert.equal(await readFile(file, "utf-8"), broken);
  });
});

test("valid JSON that is not an object rejects instead of being overwritten", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");
    await writeFile(file, "[]", "utf-8");

    await assert.rejects(() => updateJsonConfigFile(file, (config) => ({ ...config, x: 1 })));
    assert.equal(await readFile(file, "utf-8"), "[]");
  });
});

test("a UTF-8 BOM does not break read-modify-write", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");
    await writeFile(file, `${String.fromCharCode(0xfeff)}${JSON.stringify({ keep: true })}`, "utf-8");

    await updateJsonConfigFile(file, (config) => ({ ...config, added: true }));

    const parsed = JSON.parse(await readFile(file, "utf-8")) as Record<string, unknown>;
    assert.equal(parsed.keep, true);
    assert.equal(parsed.added, true);
  });
});

test("a missing file starts from an empty object", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");

    await updateJsonConfigFile(file, (config) => ({ ...config, fresh: true }));

    assert.deepEqual(JSON.parse(await readFile(file, "utf-8")), { fresh: true });
  });
});

test("no temp files are left behind", async () => {
  await withTempDir(async (dir) => {
    const file = join(dir, "config.json");
    for (let index = 0; index < 5; index += 1) {
      await updateJsonConfigFile(file, (config) => ({ ...config, [`k${index}`]: index }));
    }
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  });
});
