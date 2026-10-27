import { describe, expect, it } from "vitest";
import {
  createSshFileService,
  probeSshAuthentication,
  resolveRemoteStartDirectory,
} from "./sshWorkspaceFileService.js";

const spec = { host: "203.0.113.10", username: "root", remotePath: "/root/app" };
const windowsSpec = {
  host: "192.168.87.20",
  username: "agent",
  remotePath: "C:\\work",
  platform: "windows" as const,
};

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

  it("starts at the Windows user profile on a PowerShell remote", async () => {
    expect(await resolveRemoteStartDirectory(windowsSpec, runner("C:\\Users\\agent\r\n"))).toBe(
      "C:\\Users\\agent",
    );
  });

  it("falls back to the system drive when the Windows probe fails", async () => {
    expect(await resolveRemoteStartDirectory(windowsSpec, runner("", 1))).toBe("C:\\");
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

  it("uses an encoded PowerShell probe for Windows remotes", async () => {
    let command = "";
    await resolveRemoteStartDirectory(windowsSpec, async (_spec, remoteCommand) => {
      command = remoteCommand;
      return { code: 0, stdout: Buffer.from("C:\\Users\\agent", "utf8"), stderr: "" };
    });
    expect(command.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand ")).toBe(true);
    const script = Buffer.from(command.split(" ").at(-1) ?? "", "base64").toString("utf16le");
    expect(script).toContain("$env:USERPROFILE");
  });
});

describe("probeSshAuthentication", () => {
  it("normalizes an authentication failure into a product message", async () => {
    // 认证失败必须在连接步骤就报错，不能拖到目录步骤才暴露；
    // 系统 ssh 的英文原文单独看不明所以，要归一化成产品提示。
    await expect(
      probeSshAuthentication(spec, async () => ({
        code: 255,
        stdout: Buffer.alloc(0),
        stderr: "user@192.168.87.20: Permission denied (publickey,password,keyboard-interactive).",
      })),
    ).rejects.toThrow(/SSH 认证失败/u);
  });

  it("keeps the raw stderr for non-auth failures", async () => {
    await expect(
      probeSshAuthentication(spec, async () => ({
        code: 255,
        stdout: Buffer.alloc(0),
        stderr: "ssh: connect to host 192.168.87.20 port 22: Connection timed out",
      })),
    ).rejects.toThrow(/Connection timed out/u);
  });

  it("falls back to the exit code when ssh prints nothing", async () => {
    await expect(
      probeSshAuthentication(spec, async () => ({
        code: 255,
        stdout: Buffer.alloc(0),
        stderr: "",
      })),
    ).rejects.toThrow(/ssh exited 255/u);
  });

  it("resolves once the remote command succeeds", async () => {
    let command = "";
    await probeSshAuthentication(spec, async (_spec, remoteCommand) => {
      command = remoteCommand;
      return { code: 0, stdout: Buffer.from("zcode-ssh-probe", "utf8"), stderr: "" };
    });
    // 只用 echo：cmd 与 POSIX shell 都有，避免把远端 shell 差异误报成认证失败。
    expect(command).toBe("echo zcode-ssh-probe");
  });
});

type FakeResult = { code?: number; stdout?: string | Buffer; stderr?: string };

function fakeRunner(handler: (command: string) => FakeResult) {
  const commands: string[] = [];
  const stdins: Buffer[] = [];
  const run = async (
    _spec: unknown,
    command: string,
    options?: { stdin?: Buffer },
  ): Promise<{ code: number | null; stdout: Buffer; stderr: string }> => {
    commands.push(command);
    if (options?.stdin) stdins.push(options.stdin);
    const result = handler(command);
    return {
      code: result.code ?? 0,
      stdout: Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? "", "utf8"),
      stderr: result.stderr ?? "",
    };
  };
  return { run, commands, stdins };
}

const posixSshSpec = { host: "203.0.113.10", username: "root", remotePath: "/srv/app" };
const windowsSshSpec = {
  host: "192.168.87.20",
  username: "agent",
  remotePath: "C:\\work",
  platform: "windows" as const,
};

describe("createSshFileService", () => {
  it("keeps POSIX readdir parsing unchanged", async () => {
    const fake = fakeRunner(() => ({ stdout: "d\tsrc\nf\tREADME.md\n" }));
    const service = createSshFileService(posixSshSpec, fake.run as never);

    const entries = await service.readdir({ path: "/srv/app" });

    expect(fake.commands[0]).toContain("find '/srv/app' -mindepth 1 -maxdepth 1");
    expect(entries.map((entry) => entry.path)).toEqual(["/srv/app/src", "/srv/app/README.md"]);
  });

  it("reads Windows directories through Get-ChildItem", async () => {
    const fake = fakeRunner(() => ({ stdout: "d\tUsers\nf\tnote.txt\n" }));
    const service = createSshFileService(windowsSshSpec, fake.run as never);

    const entries = await service.readdir({ path: "C:\\work" });

    expect(
      fake.commands[0]?.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand "),
    ).toBe(true);
    expect(entries.map((entry) => entry.path)).toEqual(["C:\\work\\Users", "C:\\work\\note.txt"]);
  });

  it("parses Windows stat output", async () => {
    const fake = fakeRunner(() => ({ stdout: "file|12|1700000000" }));
    const service = createSshFileService(windowsSshSpec, fake.run as never);

    expect(await service.stat({ path: "C:\\work\\a.txt" })).toEqual({
      path: "C:\\work\\a.txt",
      type: "file",
      size: 12,
      mtimeMs: 1700000000000,
    });
  });

  it("maps exists results back onto the requested paths", async () => {
    const fake = fakeRunner(() => ({ stdout: "1\n0" }));
    const service = createSshFileService(windowsSshSpec, fake.run as never);

    expect(await service.checkFilesExist({ paths: ["C:\\a.txt", "C:\\b.txt"] })).toEqual([
      { path: "C:\\a.txt", exists: true },
      { path: "C:\\b.txt", exists: false },
    ]);
  });

  it("decodes Windows base64 ranges for text reads", async () => {
    const fake = fakeRunner((command) =>
      command.includes("Get-Item")
        ? { stdout: "file|5|1700000000" }
        : { stdout: Buffer.from("hello").toString("base64") },
    );
    const service = createSshFileService(windowsSshSpec, fake.run as never);

    const slice = await service.readTextFile({ path: "C:\\work\\a.txt", offset: 0, length: 32 });

    expect(slice.content).toBe("hello");
    expect(slice.bytesRead).toBe(5);
    expect(slice.truncated).toBe(false);
  });

  it("reads raw POSIX bytes without base64 decoding", async () => {
    const fake = fakeRunner((command) =>
      command.includes("stat -c") ? { stdout: "file|5|1700000000" } : { stdout: "hello" },
    );
    const service = createSshFileService(posixSshSpec, fake.run as never);

    const slice = await service.readTextFile({ path: "/srv/app/a.txt", offset: 0, length: 32 });

    expect(slice.content).toBe("hello");
    expect(slice.isBinary).toBe(false);
  });

  it("writes POSIX file content through stdin", async () => {
    const fake = fakeRunner(() => ({}));
    const service = createSshFileService(posixSshSpec, fake.run as never);

    await service.writeAgentPrompt({
      scope: "project",
      rootPath: "/srv/app",
      name: "review.md",
      content: "check the diff\n",
    });

    expect(fake.stdins[0]?.toString("utf8")).toBe("check the diff\n");
    expect(fake.commands[0]).toContain("mkdir -p");
  });
});
