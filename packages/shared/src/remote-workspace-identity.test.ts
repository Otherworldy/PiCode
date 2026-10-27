import { describe, expect, it } from "vitest";
import {
  buildRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
} from "./remote-workspace-identity.js";

const sshTarget = { kind: "ssh", host: "192.168.87.20", port: 22, username: "test" } as const;

describe("parseRemoteWorkspaceIdentity", () => {
  it("restores the Windows drive prefix instead of returning a POSIX path", () => {
    // identity 里的 path 段恒以 "/" 开头（POSIX 归一的契约），但 Windows 远端
    // `C:\Users\test` 会被还原成 `/C:/Users/test`。消费方直接用它当 workingDirectory 时，
    // Windows 上 resolve 会拼出 `C:\C:\Users\test`，agent 因此丢掉了 SSH 身份。
    const identity = buildRemoteWorkspaceIdentity("C:\\Users\\test", sshTarget);

    expect(identity).toBe("remote:ssh:192.168.87.20:22:test:C:/Users/test");
    expect(parseRemoteWorkspaceIdentity(identity)).toEqual({
      kind: "ssh",
      workspacePath: "C:/Users/test",
    });
  });

  it("keeps POSIX remote paths unchanged", () => {
    const identity = buildRemoteWorkspaceIdentity("/srv/app", sshTarget);

    expect(parseRemoteWorkspaceIdentity(identity)).toEqual({
      kind: "ssh",
      workspacePath: "/srv/app",
    });
  });

  it("accepts the legacy /C:/ prefixed form", () => {
    expect(parseRemoteWorkspaceIdentity("remote:ssh:192.168.87.20:22:test:/C:/Users/test")).toEqual(
      { kind: "ssh", workspacePath: "C:/Users/test" },
    );
  });

  it("still rejects non-remote identities", () => {
    expect(parseRemoteWorkspaceIdentity("D:\\Study\\Code")).toBeNull();
  });
});
