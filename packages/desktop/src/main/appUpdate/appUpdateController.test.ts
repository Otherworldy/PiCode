import { describe, expect, it, vi } from "vitest";
import type { AppUpdateSnapshot } from "@zcode/shared";
import { createAppUpdateController } from "./appUpdateController.js";

function releaseResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const latest = {
  tag_name: "v3.14.4",
  body: "fix",
  assets: [
    {
      name: "PiCode-3.14.4-win-x64.exe",
      browser_download_url: "https://example.com/PiCode.exe",
      size: 20,
    },
  ],
};

describe("app update controller", () => {
  it("reports an available installer when the release is newer", async () => {
    const controller = createAppUpdateController({
      currentVersion: "3.14.3",
      runtime: { platform: "win32", arch: "x64" },
      isPackaged: true,
      tempDir: "C:/tmp",
      fetchImpl: vi.fn(async () => releaseResponse(latest)),
      installImpl: vi.fn(async () => "quit-for-installer" as const),
    });

    const snapshot = await controller.check();
    expect(snapshot.phase).toBe("available");
    expect(snapshot.assetName).toBe("PiCode-3.14.4-win-x64.exe");
  });

  it("does not install a download that a newer check has already replaced", async () => {
    let tag = "v3.14.4";
    let releaseDownload: (() => void) | undefined;
    const installImpl = vi.fn(async () => "quit-for-installer" as const);
    const controller = createAppUpdateController({
      currentVersion: "3.14.3",
      runtime: { platform: "win32", arch: "x64" },
      isPackaged: true,
      tempDir: "C:/tmp",
      fetchImpl: vi.fn(async () => releaseResponse({ ...latest, tag_name: tag })),
      downloadImpl: () =>
        new Promise((resolve) => {
          releaseDownload = () => resolve();
        }),
      installImpl,
    });
    await controller.check();
    const downloading = controller.downloadAndInstall();
    tag = "v3.14.3";
    const checked = await controller.check();
    releaseDownload?.();
    const finished = await downloading;
    expect(installImpl).not.toHaveBeenCalled();
    expect(checked.phase).toBe("upToDate");
    expect(finished.phase).toBe("upToDate");
  });

  it("refuses to download when the app is not packaged", async () => {
    const downloadImpl = vi.fn(async () => undefined);
    const controller = createAppUpdateController({
      currentVersion: "3.14.3",
      runtime: { platform: "win32", arch: "x64" },
      isPackaged: false,
      tempDir: "C:/tmp",
      fetchImpl: vi.fn(async () => releaseResponse(latest)),
      downloadImpl,
      installImpl: vi.fn(async () => "quit-for-installer" as const),
    });
    await controller.check();
    const snapshot: AppUpdateSnapshot = await controller.downloadAndInstall();
    expect(snapshot.errorCode).toBe("unpackaged");
    expect(downloadImpl).not.toHaveBeenCalled();
  });
});
