import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WINDOWS_PACKAGED_RESOURCE_DIRS = ["glm", "tools"];

function listResourceEntries(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .slice(0, 20)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

export function snapshotWindowsPackagedResources(resourcesPath: string): Array<{
  dir: string;
  path: string;
  exists: boolean;
  entries: string[];
}> {
  return WINDOWS_PACKAGED_RESOURCE_DIRS.map((dir) => {
    const path = join(resourcesPath, dir);
    const exists = existsSync(path);
    return {
      dir,
      path,
      exists,
      entries: exists ? listResourceEntries(path) : [],
    };
  });
}
