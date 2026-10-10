import { describe, expect, it } from "vitest";
import { normalizeUpdateProxy, shouldBypassUpdateProxy } from "./proxyFetch.js";

describe("update proxy", () => {
  it("accepts a host:port proxy from settings", () => {
    expect(normalizeUpdateProxy("127.0.0.1:7890")).toBe("http://127.0.0.1:7890/");
  });

  it("skips the proxy when the host is listed in No Proxy", () => {
    expect(
      shouldBypassUpdateProxy("https://github.com/Otherworldy/PiCode", "github.com, example.com"),
    ).toBe(true);
    expect(
      shouldBypassUpdateProxy("https://release-assets.githubusercontent.com/a", "github.com"),
    ).toBe(false);
  });
});
