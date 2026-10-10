import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  compareNumericVersions,
  githubLatestReleaseUrl,
  readGitHubLatestRelease,
  selectReleaseAsset,
  type AppUpdateErrorCode,
  type AppUpdateInstallKind,
  type AppUpdateRuntime,
  type AppUpdateSnapshot,
} from "@zcode/shared";
import { AppUpdateAborted, downloadReleaseAsset } from "./downloadReleaseAsset.js";

const PROGRESS_INTERVAL_MS = 200;

export interface AppUpdateControllerDeps {
  currentVersion: string;
  runtime: AppUpdateRuntime;
  isPackaged: boolean;
  repository?: string;
  tempDir: string;
  fetchImpl?: typeof fetch;
  downloadImpl?: typeof downloadReleaseAsset;
  installImpl: (filePath: string) => Promise<AppUpdateInstallKind>;
  fileExists?: (filePath: string) => boolean;
  now?: () => number;
  broadcast?: (snapshot: AppUpdateSnapshot) => void;
}

export function createAppUpdateController(deps: AppUpdateControllerDeps) {
  let generation = 0;
  let assetUrl: string | undefined;
  let assetSize = 0;
  let filePath: string | undefined;
  let abort: AbortController | undefined;
  let downloadOperation: Promise<AppUpdateSnapshot> | null = null;
  let lastProgressAt = 0;
  const fileExists = deps.fileExists ?? existsSync;
  let snapshot: AppUpdateSnapshot = {
    phase: "idle",
    currentVersion: deps.currentVersion,
  };

  const publish = (next: AppUpdateSnapshot) => {
    snapshot = next;
    deps.broadcast?.(snapshot);
  };

  const fail = (errorCode: AppUpdateErrorCode): AppUpdateSnapshot => {
    publish({
      ...snapshot,
      phase: "error",
      errorCode,
      receivedBytes: undefined,
      totalBytes: undefined,
    });
    return snapshot;
  };

  const check = async (): Promise<AppUpdateSnapshot> => {
    const readyDownload =
      snapshot.phase === "downloaded" && filePath && fileExists(filePath)
        ? {
            snapshot: { ...snapshot },
            filePath,
            assetUrl,
            assetSize,
          }
        : undefined;
    generation += 1;
    const currentGeneration = generation;
    if (!readyDownload) {
      abort?.abort();
      abort = undefined;
      assetUrl = undefined;
      assetSize = 0;
      filePath = undefined;
      publish({ phase: "checking", currentVersion: deps.currentVersion });
    }
    const restoreReadyDownload = (): AppUpdateSnapshot | undefined => {
      if (!readyDownload || currentGeneration !== generation) return undefined;
      assetUrl = readyDownload.assetUrl;
      assetSize = readyDownload.assetSize;
      filePath = readyDownload.filePath;
      publish(readyDownload.snapshot);
      return snapshot;
    };
    try {
      const response = await (deps.fetchImpl ?? fetch)(githubLatestReleaseUrl(deps.repository), {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "PiCode",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (currentGeneration !== generation) return snapshot;
      if (response.status === 404) return restoreReadyDownload() ?? fail("no-release");
      if (!response.ok) return restoreReadyDownload() ?? fail("network");
      const release = readGitHubLatestRelease(await response.json());
      if (currentGeneration !== generation) return snapshot;
      if (!release) return restoreReadyDownload() ?? fail("network");
      if (compareNumericVersions(deps.currentVersion, release.version) >= 0) {
        publish({
          phase: "upToDate",
          currentVersion: deps.currentVersion,
          latestVersion: release.version,
        });
        return snapshot;
      }
      const asset = selectReleaseAsset(release.assets, deps.runtime);
      if (!asset) {
        publish({
          phase: "error",
          currentVersion: deps.currentVersion,
          latestVersion: release.version,
          notes: release.notes,
          errorCode: "no-asset",
        });
        return snapshot;
      }
      if (
        readyDownload &&
        readyDownload.snapshot.latestVersion === release.version &&
        readyDownload.snapshot.assetName === asset.name
      ) {
        return restoreReadyDownload() ?? snapshot;
      }
      assetUrl = asset.url;
      assetSize = asset.size;
      publish({
        phase: "available",
        currentVersion: deps.currentVersion,
        latestVersion: release.version,
        notes: release.notes,
        assetName: asset.name,
      });
      return snapshot;
    } catch {
      if (currentGeneration !== generation) return snapshot;
      return restoreReadyDownload() ?? fail("network");
    }
  };

  const download = (): Promise<AppUpdateSnapshot> => startTransfer(false);

  const downloadAndInstall = (): Promise<AppUpdateSnapshot> => startTransfer(true);

  const startTransfer = (installAfterDownload: boolean): Promise<AppUpdateSnapshot> => {
    const operation = (downloadOperation ??= runDownloadAndInstall(installAfterDownload).finally(
      () => {
        downloadOperation = null;
      },
    ));
    if (!installAfterDownload) return operation;
    return operation.then((result) => {
      if (result.phase !== "downloaded" || !filePath || result.installKind) return result;
      return installDownloaded(filePath, generation);
    });
  };

  const runDownloadAndInstall = async (
    installAfterDownload: boolean,
  ): Promise<AppUpdateSnapshot> => {
    if (!deps.isPackaged) return fail("unpackaged");
    if (!assetUrl || !snapshot.assetName || !snapshot.latestVersion) return fail("no-asset");
    if (snapshot.phase === "downloading" || snapshot.phase === "installing") return snapshot;
    const currentGeneration = generation;
    if (
      snapshot.phase === "downloaded" &&
      filePath &&
      fileExists(filePath) &&
      snapshot.installKind !== "quit-for-installer" &&
      snapshot.installKind !== "relaunch"
    ) {
      return installAfterDownload
        ? installDownloaded(filePath, currentGeneration)
        : snapshot;
    }
    const target = join(deps.tempDir, safeFileName(snapshot.latestVersion, snapshot.assetName));
    filePath = target;
    abort = new AbortController();
    publish({
      ...snapshot,
      phase: "downloading",
      errorCode: undefined,
      receivedBytes: 0,
      totalBytes: assetSize || undefined,
      installKind: undefined,
    });
    try {
      await (deps.downloadImpl ?? downloadReleaseAsset)({
        url: assetUrl,
        filePath: target,
        fallbackTotal: assetSize,
        fetchImpl: deps.fetchImpl,
        signal: abort.signal,
        onProgress: (received, total) => {
          if (currentGeneration !== generation) return;
          const now = deps.now?.() ?? Date.now();
          if (now - lastProgressAt < PROGRESS_INTERVAL_MS && received < total) return;
          lastProgressAt = now;
          publish({
            ...snapshot,
            phase: "downloading",
            receivedBytes: received,
            totalBytes: total,
          });
        },
      });
    } catch (error) {
      if (currentGeneration !== generation || error instanceof AppUpdateAborted) return snapshot;
      return fail("download-failed");
    }
    if (currentGeneration !== generation) return snapshot;
    publish({
      ...snapshot,
      phase: "downloaded",
      receivedBytes: undefined,
      totalBytes: undefined,
      errorCode: undefined,
    });
    return installAfterDownload ? installDownloaded(target, currentGeneration) : snapshot;
  };

  const installDownloaded = async (
    target: string,
    currentGeneration: number,
  ): Promise<AppUpdateSnapshot> => {
    publish({ ...snapshot, phase: "installing", errorCode: undefined });
    try {
      const installKind = await deps.installImpl(target);
      if (currentGeneration !== generation) return snapshot;
      publish({ ...snapshot, phase: "downloaded", installKind, errorCode: undefined });
      return snapshot;
    } catch {
      if (currentGeneration !== generation) return snapshot;
      return fail("install-failed");
    }
  };

  return {
    snapshot: () => snapshot,
    check,
    download,
    downloadAndInstall,
  };
}

function safeFileName(version: string, assetName: string): string {
  const base = assetName.split(/[/\\]/).pop() ?? "update.bin";
  const cleaned = `${version}-${base}`.replace(/[^A-Za-z0-9._-]+/g, "_");
  return cleaned.length > 0 ? cleaned : "update.bin";
}
