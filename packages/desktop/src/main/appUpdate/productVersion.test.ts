import { describe, expect, it } from "vitest";
import { resolveDesktopProductVersion } from "./productVersion.js";

describe("desktop product version", () => {
  it("does not use the Electron runtime version as the app version", () => {
    expect(
      resolveDesktopProductVersion({
        injectedVersion: "0.0.0-dev",
        electronAppVersion: "41.0.3",
        electronRuntimeVersion: "41.0.3",
        packageVersion: "3.14.3",
      }),
    ).toBe("3.14.3");
  });

  it("prefers the injected product version over Electron", () => {
    expect(
      resolveDesktopProductVersion({
        injectedVersion: "3.14.3",
        electronAppVersion: "41.0.3",
        electronRuntimeVersion: "41.0.3",
      }),
    ).toBe("3.14.3");
  });
});
