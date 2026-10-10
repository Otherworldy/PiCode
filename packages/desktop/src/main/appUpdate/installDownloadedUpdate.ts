import { chmod, copyFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import type { AppUpdateInstallKind } from "@zcode/shared";

interface InstallCommand {
  unref(): void;
}

export async function installDownloadedUpdate(options: {
  filePath: string;
  platform: string;
  appImagePath?: string;
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

  // assisted NSIS 只有同时静默且 --force-run 才会跳过向导，并在结束后重新打开应用。
  launch(options.filePath, ["/S", "--updated", "--force-run"]);
  options.quit();
  return "quit-for-installer";
}
