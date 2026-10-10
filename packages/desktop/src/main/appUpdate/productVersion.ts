import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEV_FALLBACK_VERSION = "0.0.0-dev";

export function resolveDesktopProductVersion(input: {
  packageVersion?: string;
  injectedVersion?: string;
  metadataVersion?: string;
  electronAppVersion?: string;
  electronRuntimeVersion?: string;
}): string {
  for (const candidate of [input.packageVersion, input.metadataVersion, input.injectedVersion]) {
    if (isProductVersion(candidate)) return candidate.trim();
  }
  if (
    isProductVersion(input.electronAppVersion) &&
    input.electronAppVersion.trim() !== input.electronRuntimeVersion
  ) {
    return input.electronAppVersion.trim();
  }
  return DEV_FALLBACK_VERSION;
}

export function readWorkspacePackageVersion(startDir: string): string | undefined {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === "zcode" && isProductVersion(parsed.version)) {
          return parsed.version.trim();
        }
      } catch {
        // 继续向上找仓库根 package.json。
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
}

function isProductVersion(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.trim() !== "unknown" &&
    value.trim() !== DEV_FALLBACK_VERSION
  );
}
