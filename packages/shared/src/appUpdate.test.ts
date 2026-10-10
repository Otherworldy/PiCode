import { describe, expect, it } from "vitest";
import {
  compareNumericVersions,
  readGitHubLatestRelease,
  selectReleaseAsset,
  type ReleaseAssetCandidate,
} from "./appUpdate.js";

const assets: ReleaseAssetCandidate[] = [
  { name: "PiCode-3.14.4-win-x64.exe", url: "https://example.com/win.exe", size: 10 },
  { name: "PiCode-3.14.4-win-arm64.exe", url: "https://example.com/win-arm.exe", size: 10 },
  { name: "PiCode-3.14.4-mac-arm64.dmg", url: "https://example.com/mac.dmg", size: 10 },
  { name: "PiCode-3.14.4-mac-arm64.zip", url: "https://example.com/mac.zip", size: 10 },
  {
    name: "PiCode-3.14.4-linux-x86_64.AppImage",
    url: "https://example.com/linux.AppImage",
    size: 10,
  },
  { name: "PiCode-3.14.4-linux-amd64.deb", url: "https://example.com/linux.deb", size: 10 },
  {
    name: "PiCode Preview-3.14.4-win-x64_TEST.exe",
    url: "https://example.com/win-test.exe",
    size: 10,
  },
];

describe("app update release selection", () => {
  it("compares numeric release versions and ignores a leading v", () => {
    expect(compareNumericVersions("3.14.3", "v3.14.4")).toBeLessThan(0);
    expect(compareNumericVersions("v3.14.3", "3.14.3")).toBe(0);
    expect(compareNumericVersions("3.14.10", "3.14.9")).toBeGreaterThan(0);
  });

  it("picks the installer for the current os and architecture", () => {
    expect(selectReleaseAsset(assets, { platform: "win32", arch: "x64" })?.name).toBe(
      "PiCode-3.14.4-win-x64.exe",
    );
    expect(selectReleaseAsset(assets, { platform: "darwin", arch: "arm64" })?.name).toBe(
      "PiCode-3.14.4-mac-arm64.dmg",
    );
    expect(selectReleaseAsset(assets, { platform: "linux", arch: "x64" })?.name).toBe(
      "PiCode-3.14.4-linux-x86_64.AppImage",
    );
    expect(selectReleaseAsset(assets, { platform: "linux", arch: "arm64" })).toBeNull();
  });

  it("reads a GitHub latest release and drops non-https assets", () => {
    const release = readGitHubLatestRelease({
      tag_name: "v3.14.4",
      body: "notes",
      assets: [
        { name: "ok.exe", browser_download_url: "https://example.com/ok.exe", size: 4 },
        { name: "bad.exe", browser_download_url: "http://example.com/bad.exe", size: 4 },
      ],
    });
    expect(release).toEqual({
      version: "v3.14.4",
      notes: "notes",
      assets: [{ name: "ok.exe", url: "https://example.com/ok.exe", size: 4 }],
    });
  });
});
