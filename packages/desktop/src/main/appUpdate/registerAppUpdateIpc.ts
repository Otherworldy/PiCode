import { app, BrowserWindow, ipcMain } from "electron";
import { PlatformChannels, ZCODE_VERSION, type AppUpdateSnapshot } from "@zcode/shared";
import { readBuildMetadata } from "../about.js";
import { createAppUpdateController } from "./appUpdateController.js";
import { installDownloadedUpdate } from "./installDownloadedUpdate.js";
import { readWorkspacePackageVersion, resolveDesktopProductVersion } from "./productVersion.js";
import { createUpdateFetch, type UpdateNetworkSettings } from "./proxyFetch.js";

export function registerAppUpdateIpc(options: {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  quit: () => void;
  readNetworkSettings?: () => Promise<UpdateNetworkSettings>;
}): void {
  const fetchImpl: typeof fetch = async (input, init) => {
    const settings = (await options.readNetworkSettings?.()) ?? {};
    return createUpdateFetch(settings)(input, init);
  };
  const controller = createAppUpdateController({
    fetchImpl,
    currentVersion: resolveDesktopProductVersion({
      packageVersion: app.isPackaged ? undefined : readWorkspacePackageVersion(import.meta.dirname),
      metadataVersion: readBuildMetadata()?.appVersion,
      injectedVersion: ZCODE_VERSION,
      electronAppVersion: app.getVersion(),
      electronRuntimeVersion: process.versions.electron,
    }),
    runtime: { platform: process.platform, arch: process.arch },
    isPackaged: app.isPackaged,
    tempDir: app.getPath("temp"),
    broadcast: (snapshot) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(PlatformChannels.AppUpdateStateChanged, snapshot);
        }
      }
    },
    installImpl: (filePath) =>
      installDownloadedUpdate({
        filePath,
        platform: process.platform,
        ...(process.env.APPIMAGE ? { appImagePath: process.env.APPIMAGE } : {}),
        quit: options.quit,
      }),
  });

  const logResult = (action: string, snapshot: AppUpdateSnapshot) => {
    if (snapshot.phase === "error") {
      options.logger.warn("[app-update] failed", { action, errorCode: snapshot.errorCode });
      return;
    }
    options.logger.info("[app-update]", {
      action,
      phase: snapshot.phase,
      latestVersion: snapshot.latestVersion,
      assetName: snapshot.assetName,
    });
  };

  ipcMain.handle(PlatformChannels.GetAppUpdateState, () => controller.snapshot());
  ipcMain.handle(PlatformChannels.CheckAppUpdate, async () => {
    const snapshot = await controller.check();
    logResult("check", snapshot);
    return snapshot;
  });
  ipcMain.handle(PlatformChannels.DownloadAppUpdate, async () => {
    const snapshot = await controller.downloadAndInstall();
    logResult("install", snapshot);
    return snapshot;
  });
}
