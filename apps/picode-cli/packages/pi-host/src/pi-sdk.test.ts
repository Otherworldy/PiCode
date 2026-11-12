import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { piVersionsCompatible, readGlobalPiPackage } from "./pi-sdk.js";

test("pi sdk compatibility is major.minor", () => {
  assert.equal(piVersionsCompatible("0.86.1", "0.86.9"), true);
  assert.equal(piVersionsCompatible("0.86.1", "0.87.0"), false);
  assert.equal(piVersionsCompatible("0.86.1", ""), false);
});

test("readGlobalPiPackage reads a global-shaped install", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-sdk-"));
  const root = join(prefix, "node_modules");
  const pkg = join(root, "@earendil-works", "pi-coding-agent");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "index.js"), "module.exports = {};\n");
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.86.1", main: "index.js" }),
  );
  const found = readGlobalPiPackage(root);
  assert.equal(found?.version, "0.86.1");
  assert.equal(found?.entry.endsWith("index.js"), true);
  assert.equal(readGlobalPiPackage(join(root, "missing")), undefined);
  await rm(prefix, { recursive: true, force: true });
});
