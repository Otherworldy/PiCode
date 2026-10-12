import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AppUpdateSnapshot, IPlatformService } from "@zcode/shared";
import { AppUpdateReadyButton } from "./AppUpdateReadyButton.js";
import { PlatformProvider } from "./hooks/usePlatform.js";
import { ZCodeIntlProvider } from "./i18n/IntlProvider.js";

function renderWithProviders(platform: Partial<IPlatformService>, children: ReactNode) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider>
      <PlatformProvider platform={platform as IPlatformService}>{children}</PlatformProvider>
    </ZCodeIntlProvider>,
  );
}

describe("AppUpdateReadyButton", () => {
  it("does not render when update state is not downloaded", () => {
    const platform: Partial<IPlatformService> = {
      getAppUpdateState: async () => ({ phase: "upToDate" }) as AppUpdateSnapshot,
      downloadAppUpdate: async () => ({ phase: "upToDate" }) as AppUpdateSnapshot,
    };
    const html = renderWithProviders(platform, <AppUpdateReadyButton />);
    expect(html).toBe("");
  });

  it("renders yellow button classes when update snapshot is downloaded", () => {
    const platform: Partial<IPlatformService> = {
      getAppUpdateState: async () =>
        ({ phase: "downloaded", latestVersion: "v1.0.0" }) as AppUpdateSnapshot,
      downloadAppUpdate: async () =>
        ({ phase: "downloaded", latestVersion: "v1.0.0" }) as AppUpdateSnapshot,
    };
    const html = renderWithProviders(
      platform,
      <AppUpdateReadyButton
        initialSnapshot={{ phase: "downloaded", latestVersion: "v1.0.0" } as AppUpdateSnapshot}
      />,
    );
    expect(html).toContain("bg-[#e6a23c]");
    expect(html).toContain("text-white");
    expect(html).toContain("text-ui-caption");
    expect(html).toContain("更新");
  });
});
