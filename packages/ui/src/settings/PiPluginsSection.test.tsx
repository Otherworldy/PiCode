import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { PiPluginsSection } from "./PiPluginsSection.js";

vi.mock("@/hooks/usePiCodeSessionService.js", () => ({ useZCodeSessionService: () => ({}) }));
vi.mock("./PiPluginConfigDialog.js", () => ({ PiPluginConfigDialog: () => null }));

describe("PiPluginsSection reload hint", () => {
  it.each(["user", "project"] as const)(
    "keeps the existing-session hint visible outside the installed panel (%s)",
    (scope) => {
      const html = renderToStaticMarkup(
        <ZCodeIntlProvider>
          <PiPluginsSection workspacePath="/workspace" scope={scope} searchQuery="" />
        </ZCodeIntlProvider>,
      );
      expect(html).toContain(zhCN["settings.plugins.pi.reloadHint"]);
      expect(html).toContain("text-ui-sm text-foreground-subtle");
    },
  );
  it("explains all four mutation types in both languages", () => {
    expect(zhCN["settings.plugins.pi.reloadHint"]).toContain("安装、卸载、更新或启停");
    expect(enUS["settings.plugins.pi.reloadHint"]).toContain(
      "installing, removing, updating, or enabling/disabling",
    );
    expect(enUS["settings.plugins.pi.reloadHint"]).toContain("existing sessions");
  });
});
