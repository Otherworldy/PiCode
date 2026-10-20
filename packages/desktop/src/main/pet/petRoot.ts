import { dirname, join } from "node:path";

/** 打包后写到安装目录的 pets。开发态没有安装目录，写到应用目录，避免落到系统盘的用户数据目录。 */
export function resolveDesktopPetRootDir(input: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath?: string;
  appPath: string;
}): string {
  const resourcesPath = input.resourcesPath?.trim();
  if (input.isPackaged && resourcesPath) {
    const installDir =
      input.platform === "darwin"
        ? dirname(dirname(dirname(resourcesPath)))
        : dirname(resourcesPath);
    return join(installDir, "pets");
  }
  return join(input.appPath, "pets");
}
