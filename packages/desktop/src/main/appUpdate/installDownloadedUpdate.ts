import { chmod, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { AppUpdateInstallKind } from "@zcode/shared";

interface InstallCommand {
  unref(): void;
}

/** 安装器接管后应用必须退出；先让界面上的等待态留够可读时间。 */
const INSTALL_NOTICE_DWELL_MS = 2500;

export async function installDownloadedUpdate(options: {
  filePath: string;
  platform: string;
  appImagePath?: string;
  /** 静默安装期间独立于安装目录的进度小窗；拉起失败不影响安装。 */
  splash?: () => Promise<void>;
  sleepImpl?: (ms: number) => Promise<void>;
  spawnImpl?: (
    command: string,
    args: string[],
    spawnOptions: { detached: true; stdio: "ignore" },
  ) => InstallCommand;
  copyFileImpl?: (source: string, target: string) => Promise<void>;
  chmodImpl?: (path: string, mode: number) => Promise<void>;
  quit: () => void;
}): Promise<AppUpdateInstallKind> {
  const spawnImpl = options.spawnImpl ?? spawn;
  const launch = (command: string, args: string[]) => {
    const child = spawnImpl(command, args, { detached: true, stdio: "ignore" });
    child.unref();
  };

  if (options.platform === "darwin") {
    launch("open", [options.filePath]);
    return "opened-installer";
  }

  if (options.platform === "linux") {
    await (options.chmodImpl ?? chmod)(options.filePath, 0o755);
    if (options.appImagePath) {
      await (options.copyFileImpl ?? copyFile)(options.filePath, options.appImagePath);
      launch(options.appImagePath, []);
      options.quit();
      return "relaunch";
    }
    launch(options.filePath, []);
    return "opened-installer";
  }

  // 安装器一旦接管，窗口马上就会消失：先停留，让用户读到「会关闭、约多久、会自动重开」。
  await (options.sleepImpl ?? sleep)(INSTALL_NOTICE_DWELL_MS);
  try {
    await options.splash?.();
  } catch {
    // 小窗只是提示层，拉起失败（例如策略禁用 PowerShell）不能阻断安装。
  }
  // assisted NSIS 只有同时静默且 --force-run 才会跳过向导，并在结束后重新打开应用。
  launch(options.filePath, ["/S", "--updated", "--force-run"]);
  options.quit();
  return "quit-for-installer";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
