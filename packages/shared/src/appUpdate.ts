/** 桌面「关于」页检查的公开 GitHub 仓库。 */
export const APP_UPDATE_GITHUB_REPOSITORY = "Otherworldy/PiCode";

export type AppUpdatePhase =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export type AppUpdateErrorCode =
  | "no-release"
  | "network"
  | "no-asset"
  | "unpackaged"
  | "download-failed"
  | "install-failed";

/** quit：安装程序接替当前进程。opened：只打开安装盘。relaunch：替换后重启。 */
export type AppUpdateInstallKind = "quit-for-installer" | "opened-installer" | "relaunch";

export interface AppUpdateSnapshot {
  phase: AppUpdatePhase;
  currentVersion: string;
  latestVersion?: string;
  notes?: string;
  assetName?: string;
  receivedBytes?: number;
  totalBytes?: number;
  errorCode?: AppUpdateErrorCode;
  installKind?: AppUpdateInstallKind;
}

export interface ReleaseAssetCandidate {
  name: string;
  url: string;
  size: number;
}

export interface AppUpdateRuntime {
  platform: string;
  arch: string;
}

export interface GitHubLatestRelease {
  version: string;
  notes: string;
  assets: ReleaseAssetCandidate[];
}

const NOTES_LIMIT = 4000;

export function githubLatestReleaseUrl(repository = APP_UPDATE_GITHUB_REPOSITORY): string {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`;
}

export function compareNumericVersions(left: string, right: string): number {
  const a = numericParts(left);
  const b = numericParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function readGitHubLatestRelease(payload: unknown): GitHubLatestRelease | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.tag_name !== "string" || record.tag_name.trim().length === 0) return null;
  const notes = typeof record.body === "string" ? record.body.slice(0, NOTES_LIMIT) : "";
  const assets = Array.isArray(record.assets)
    ? record.assets.flatMap((asset) => {
        if (!asset || typeof asset !== "object") return [];
        const item = asset as Record<string, unknown>;
        if (typeof item.name !== "string" || typeof item.browser_download_url !== "string") {
          return [];
        }
        if (!item.browser_download_url.startsWith("https://")) return [];
        const size = typeof item.size === "number" && item.size > 0 ? item.size : 0;
        return [{ name: item.name, url: item.browser_download_url, size }];
      })
    : [];
  return { version: record.tag_name.trim(), notes, assets };
}

export function selectReleaseAsset(
  assets: readonly ReleaseAssetCandidate[],
  runtime: AppUpdateRuntime,
): ReleaseAssetCandidate | null {
  const rule = INSTALLER_RULES[runtime.platform];
  const arch = archPattern(runtime.arch);
  if (!rule || !arch) return null;
  const matches = assets.filter((asset) => {
    const name = asset.name.toLowerCase();
    return name.includes(rule.marker) && name.endsWith(rule.extension) && arch.test(asset.name);
  });
  matches.sort((left, right) => scoreAsset(right.name) - scoreAsset(left.name));
  return matches[0] ?? null;
}

const INSTALLER_RULES: Record<string, { marker: string; extension: string }> = {
  win32: { marker: "-win-", extension: ".exe" },
  darwin: { marker: "-mac-", extension: ".dmg" },
  linux: { marker: "-linux-", extension: ".appimage" },
};

function numericParts(version: string): number[] {
  const core = version.trim().replace(/^v/i, "").split("-")[0] ?? "";
  return core.split(".").map((part) => {
    const match = /^(\d+)/.exec(part);
    return match ? Number(match[1] ?? "0") : 0;
  });
}

function archPattern(arch: string): RegExp | null {
  if (arch === "x64") return /(?:^|[-_])(?:x64|x86_64|amd64)(?:[-_.]|$)/i;
  if (arch === "arm64") return /(?:^|[-_])(?:arm64|aarch64)(?:[-_.]|$)/i;
  if (!/^[A-Za-z0-9]+$/.test(arch)) return null;
  return new RegExp(`(?:^|[-_])${arch}(?:[-_.]|$)`, "i");
}

function scoreAsset(name: string): number {
  return name.includes("_TEST") ? 0 : 1;
}
