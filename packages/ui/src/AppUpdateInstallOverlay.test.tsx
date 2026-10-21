import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateSnapshot, IPlatformService } from "@zcode/shared";
import { AppUpdateInstallOverlay } from "./AppUpdateInstallOverlay.js";
import { PlatformProvider } from "./hooks/usePlatform.js";
import { ZCodeIntlProvider } from "./i18n/IntlProvider.js";

function renderWithProviders(platform: Partial<IPlatformService>, children: ReactNode) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider>
      <PlatformProvider platform={platform as IPlatformService}>{children}</PlatformProvider>
    </ZCodeIntlProvider>,
  );
}

const installerPlatform: Partial<IPlatformService> = {
  getAppUpdateState: async () => ({ phase: "installing" }) as AppUpdateSnapshot,
};

function renderOverlay(snapshot: AppUpdateSnapshot, platformName = "Win32") {
  vi.stubGlobal("navigator", { platform: platformName });
  return renderWithProviders(
    installerPlatform,
    <AppUpdateInstallOverlay initialSnapshot={snapshot} />,
  );
}

describe("AppUpdateInstallOverlay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not render before the installer takes over", () => {
    expect(
      renderOverlay({ phase: "downloaded", latestVersion: "v1.0.0" } as AppUpdateSnapshot),
    ).toBe("");
    expect(renderOverlay({ phase: "upToDate" } as AppUpdateSnapshot)).toBe("");
  });

  it("keeps blocking the window after the installer reports it will take over", () => {
    // installing 之后主进程还要等 prepareAppQuit，这几秒不能再放回可交互界面。
    const html = renderOverlay({
      phase: "downloaded",
      latestVersion: "v1.0.0",
      installKind: "quit-for-installer",
    } as AppUpdateSnapshot);
    expect(html).toContain('data-testid="app-update-installing-overlay"');
  });

  it("explains the closed window while the installer takes over", () => {
    const html = renderOverlay({
      phase: "installing",
      latestVersion: "v1.0.0",
    } as AppUpdateSnapshot);
    expect(html).toContain('data-testid="app-update-installing-overlay"');
    expect(html).toContain("正在安装更新");
    expect(html).toContain("1–3 分钟");
    expect(html).toContain("会自动重新打开");
  });

  it("stays hidden outside Windows", () => {
    // macOS 只打开安装盘，Linux 替换后立即重启，都没有长时间空屏。
    for (const platformName of ["MacIntel", "Linux x86_64"]) {
      const html = renderOverlay({ phase: "installing" } as AppUpdateSnapshot, platformName);
      expect(html).toBe("");
    }
  });
});
