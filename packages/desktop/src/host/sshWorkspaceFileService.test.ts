import { describe, expect, it } from "vitest";
import { resolveRemoteStartDirectory } from "./sshWorkspaceFileService.js";

const spec = { host: "203.0.113.10", username: "root", remotePath: "/root/app" };

function runner(stdout: string, code = 0) {
  return async () => ({ code, stdout: Buffer.from(stdout, "utf8"), stderr: "" });
}

describe("resolveRemoteStartDirectory", () => {
  it("starts at the remote home directory", async () => {
    expect(await resolveRemoteStartDirectory(spec, runner("/root\n"))).toBe("/root");
  });

  it("falls back to / when the probe fails", async () => {
    // 探测失败只影响目录浏览器的起始位置，不能把错误抛给连接流程。
    expect(await resolveRemoteStartDirectory(spec, runner("Permission denied\n", 255))).toBe("/");
    expect(
      await resolveRemoteStartDirectory(spec, async () => {
        throw new Error("ssh missing");
      }),
    ).toBe("/");
  });

  it("ignores relative or empty output", async () => {
    expect(await resolveRemoteStartDirectory(spec, runner(""))).toBe("/");
    expect(await resolveRemoteStartDirectory(spec, runner("root\n"))).toBe("/");
  });

  it("probes $HOME first and then the common dev directories", async () => {
    let command = "";
    await resolveRemoteStartDirectory(spec, async (_spec, remoteCommand) => {
      command = remoteCommand;
      return { code: 0, stdout: Buffer.from("/srv", "utf8"), stderr: "" };
    });
    expect(command).toContain('[ -d "$HOME" ]');
    for (const candidate of ["/www/wwwroot", "/var/www", "/opt", "/srv", "/home"]) {
      expect(command).toContain(`'${candidate}'`);
    }
  });
});
