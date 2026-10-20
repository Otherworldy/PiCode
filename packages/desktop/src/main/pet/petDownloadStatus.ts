import { BrowserWindow } from "electron";
import { PlatformChannels, type DesktopPetDownloadStatus } from "@zcode/shared";
import { PetPackDownloadError } from "./downloadPack.js";

let current: DesktopPetDownloadStatus = { phase: "idle" };
let lastSentAt = 0;

export function getDesktopPetDownloadStatus(): DesktopPetDownloadStatus {
  return current;
}

export function downloadFailureStatus(error: unknown): DesktopPetDownloadStatus {
  if (error instanceof PetPackDownloadError) {
    return error.status == null
      ? { phase: "failed", reason: error.reason }
      : { phase: "failed", reason: error.reason, status: error.status };
  }
  return { phase: "failed", reason: "network" };
}

/** 下载进度按大约 200ms 发一次，避免每个分块都打到渲染进程。完成、解压和失败立即发。 */
export function publishDesktopPetDownload(status: DesktopPetDownloadStatus): void {
  if (status.phase === "downloading") {
    const now = Date.now();
    const finished = status.total != null && status.received >= status.total && status.total > 0;
    if (!finished && status.received !== 0 && now - lastSentAt < 200) return;
    lastSentAt = now;
  }
  current = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.send(PlatformChannels.DesktopPetDownload, current);
  }
}
