import { basename, join } from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import { PlatformChannels, ZCODE_VERSION, type AppUpdateSnapshot } from "@zcode/shared";
import { readBuildMetadata } from "../about.js";
import { createAppUpdateController } from "./appUpdateController.js";
import { startAppUpdateScheduler } from "./appUpdateScheduler.js";
import { installDownloadedUpdate } from "./installDownloadedUpdate.js";
import { showInstallSplash } from "./installSplash.js";
import { readWorkspacePackageVersion, resolveDesktopProductVersion } from "./productVersion.js";
import { createUpdateFetch, type UpdateNetworkSettings } from "./proxyFetch.js";

export function registerAppUpdateIpc(options: {
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  quit: () => void;
  /** 应用内设置的界面语言：小窗文案跟它走，不用系统语言，否则会出现界面中文/小窗英文。 */
  getLocale?: () => string;
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
        // 静默安装没有界面，应用又要退出才能替换文件：退出前拉起独立小窗顶住这段空白期。
        splash: async () => {
          const latestVersion = controller.snapshot().latestVersion;
          const scriptPath = join(app.getPath("temp"), "PiCode-update-splash.ps1");
          try {
            await showInstallSplash({
              scriptPath,
              appProcessName: basename(process.execPath, ".exe"),
              appIconPath: process.execPath,
              ...(latestVersion ? { latestVersion } : {}),
              locale: options.getLocale?.() ?? app.getLocale(),
            });
            options.logger.info("[app-update] splash launched", { scriptPath });
          } catch (error) {
            // 小窗失败会退化成只剩退出前遮罩，没有日志就完全无法排障。
            options.logger.warn("[app-update] splash failed", { scriptPath, error });
            throw error;
          }
        },
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

  if (app.isPackaged) {
    startAppUpdateScheduler(controller);
  }

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
