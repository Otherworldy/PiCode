import { describe, expect, it } from "vitest";
import {
  formatRemoteWorkspaceDisplayLabel,
  formatRemoteWorkspaceHeaderHostLabel,
} from "./remoteWorkspaceHistory.js";

describe("formatRemoteWorkspaceDisplayLabel", () => {
  it("shows the ssh host instead of the folder name", () => {
    expect(
      formatRemoteWorkspaceDisplayLabel("repo", {
        kind: "ssh",
        host: "192.168.1.10",
        username: "root",
      }),
    ).toBe("192.168.1.10");
  });

  it("keeps a non-default port and does not append the ssh config alias", () => {
    expect(
      formatRemoteWorkspaceDisplayLabel("repo", {
        kind: "ssh",
        host: "10.0.0.8",
        port: 2222,
        username: "dev",
        sshConfigAlias: "box",
      }),
    ).toBe("10.0.0.8:2222");
  });

  it("omits the default ssh port", () => {
    expect(
      formatRemoteWorkspaceHeaderHostLabel({
        kind: "ssh",
        host: "192.168.1.10",
        port: 22,
        username: "root",
      }),
    ).toBe("192.168.1.10");
  });

  it("keeps the folder name for wsl and docker", () => {
    expect(formatRemoteWorkspaceDisplayLabel("repo", { kind: "wsl", distro: "Ubuntu" })).toBe(
      "repo",
    );
    expect(formatRemoteWorkspaceDisplayLabel("repo", { kind: "docker", container: "app" })).toBe(
      "repo",
    );
  });

  it("falls back to the folder name when the ssh host is blank", () => {
    expect(
      formatRemoteWorkspaceDisplayLabel("repo", {
        kind: "ssh",
        host: "   ",
        username: "root",
      }),
    ).toBe("repo");
  });
});
