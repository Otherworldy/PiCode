import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteInstalledPetPack,
  importLocalPetPack,
  listInstalledPetPacks,
} from "./installedPacks.js";

function writePack(root: string, id: string, url: string, name: string | null): void {
  const dir = join(root, id);
  const webm = join(dir, "webm");
  mkdirSync(webm, { recursive: true });
  writeFileSync(join(webm, "待机.webm"), "webm");
  writeFileSync(join(dir, ".source-url"), url);
  const pet = name === null ? "{}" : `{ "name": ${JSON.stringify(name)} }`;
  writeFileSync(
    join(dir, "config.jsonc"),
    `{ "pets": [${pet}], "animations": { "idle": ["待机"] } }`,
  );
}

describe("installed pet packs", () => {
  it("lists playable downloads by pet name and skips a folder that cannot be opened", () => {
    const root = mkdtempSync(join(tmpdir(), "pet-installed-"));
    writePack(root, "bbb", "https://example.test/b.zip", "乙");
    writePack(root, "aaa", "https://example.test/a.zip", "甲");
    writePack(root, "ccc", "https://example.test/packs/dsh-pet.zip", null);
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", ".source-url"), "https://example.test/broken.zip");
    writeFileSync(join(root, "note.txt"), "nope");

    const packs = listInstalledPetPacks(root);
    expect(
      packs.map((p) => ({ id: p.id, name: p.name, url: p.url, sourceType: p.sourceType })),
    ).toEqual([
      { id: "aaa", name: "甲", url: "https://example.test/a.zip", sourceType: "download" },
      { id: "bbb", name: "乙", url: "https://example.test/b.zip", sourceType: "download" },
      {
        id: "ccc",
        name: "dsh-pet.zip",
        url: "https://example.test/packs/dsh-pet.zip",
        sourceType: "download",
      },
    ]);
  });

  it("supports importing and deleting local and download packs", () => {
    const petRoot = mkdtempSync(join(tmpdir(), "pet-root-"));
    const packsDir = join(petRoot, "packs");
    mkdirSync(packsDir, { recursive: true });
    writePack(packsDir, "down1", "https://example.test/1.zip", "下载宠");

    // 创建本地目录
    const localDir = join(petRoot, "my-local-pet");
    const webm = join(localDir, "webm");
    mkdirSync(webm, { recursive: true });
    writeFileSync(join(webm, "待机.webm"), "webm");
    writeFileSync(
      join(localDir, "config.jsonc"),
      `{ "pets": [{ "name": "本地宠" }], "animations": { "idle": ["待机"] } }`,
    );

    const importRes = importLocalPetPack(petRoot, localDir);
    expect(importRes.success).toBe(true);
    expect(importRes.pack?.name).toBe("本地宠");
    expect(importRes.pack?.sourceType).toBe("local");

    let list = listInstalledPetPacks(petRoot);
    expect(list.length).toBe(2);
    expect(list.some((p) => p.name === "本地宠")).toBe(true);

    // 删除本地宠：仅从列表移除，本地文件仍然存在
    const localPack = list.find((p) => p.sourceType === "local")!;
    expect(deleteInstalledPetPack(petRoot, localPack.id, "local")).toBe(true);
    list = listInstalledPetPacks(petRoot);
    expect(list.length).toBe(1);

    // 删除下载宠：物理删除文件夹
    const downPack = list.find((p) => p.sourceType === "download")!;
    expect(deleteInstalledPetPack(petRoot, downPack.id, "download")).toBe(true);
    list = listInstalledPetPacks(petRoot);
    expect(list.length).toBe(0);
  });

  it("returns nothing when the cache directory is missing", () => {
    expect(listInstalledPetPacks(join(tmpdir(), "pet-installed-missing"))).toEqual([]);
  });
});
