/** 设置页展示的推荐宠物包。不是默认值，要点「使用推荐」才会填进下载地址。 */
export const DESKTOP_PET_RECOMMENDED_PACK_URL =
  "https://pub-4de328cc5516482d80f6e14e6829136d.r2.dev/dsh-pet.zip";

export type DesktopPetDownloadFailure =
  | "invalid-url"
  | "network"
  | "http"
  | "too-large"
  | "missing-config";

/** 桌面主进程拥有的下载状态。设置页只显示最新一次。 */
export type DesktopPetDownloadStatus =
  | { phase: "idle" }
  | { phase: "downloading"; received: number; total: number | null }
  | { phase: "extracting" }
  | { phase: "ready" }
  | { phase: "stopped" }
  | { phase: "failed"; reason: DesktopPetDownloadFailure; status?: number };
