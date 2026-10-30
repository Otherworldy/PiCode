import { describe, expect, it } from "vitest";
import {
  sshDestinationArgs,
  buildRemoteShellCommand,
  parseFindEntries,
  probeSshRemotePlatform,
  quoteRemoteArg,
  remoteDirname,
  remoteJoin,
  type SshRemoteSpec,
} from "./sshRemote.js";
import { buildReaddirScript, buildStatScript } from "./sshRemoteCommands.js";

const spec: SshRemoteSpec = { host: "192.168.87.20", username: "agent", remotePath: "C:\\work" };

function decodeWindowsCommand(command: string): string {
  const encoded = command.split(" ").at(-1) ?? "";
  return Buffer.from(encoded, "base64").toString("utf16le");
}

describe("quoteRemoteArg", () => {
  it("escapes PowerShell single quotes by doubling", () => {
    expect(quoteRemoteArg("C:\\it's", "windows")).toBe("'C:\\it''s'");
  });

  it("keeps POSIX escaping for posix remotes", () => {
    expect(quoteRemoteArg("/tmp/it's", "posix")).toBe("'/tmp/it'\\''s'");
  });
});

describe("buildRemoteShellCommand", () => {
  it("passes POSIX scripts through unchanged", () => {
    expect(buildRemoteShellCommand("echo hi", "posix")).toBe("echo hi");
  });

  it("wraps Windows scripts in an encoded PowerShell command", () => {
    const command = buildRemoteShellCommand("echo hi", "windows");

    expect(command.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand ")).toBe(true);
    // 前缀关掉进度流并强制 UTF-8，否则 stderr 会混进 CLIXML、中文文件名会乱码。
    const script = decodeWindowsCommand(command);
    expect(script).toContain("$ProgressPreference='SilentlyContinue'");
    expect(script).toContain("[Console]::OutputEncoding=[System.Text.Encoding]::UTF8");
    expect(script.endsWith(";echo hi")).toBe(true);
  });
});

describe("remote path helpers", () => {
  it("joins with the platform separator and keeps drive roots intact", () => {
    expect(remoteJoin("C:\\", "Users", "windows")).toBe("C:\\Users");
    expect(remoteJoin("C:\\Users", "agent", "windows")).toBe("C:\\Users\\agent");
    expect(remoteJoin("/", "home", "posix")).toBe("/home");
    expect(remoteJoin("/home", "agent", "posix")).toBe("/home/agent");
  });

  it("derives parent directories on both platforms", () => {
    expect(remoteDirname("C:\\Users\\agent", "windows")).toBe("C:\\Users");
    expect(remoteDirname("C:\\", "windows")).toBeUndefined();
    expect(remoteDirname("/home/agent", "posix")).toBe("/home");
    expect(remoteDirname("/", "posix")).toBeUndefined();
  });
});

describe("parseFindEntries", () => {
  it("joins Windows entries with backslashes", () => {
    const entries = parseFindEntries("d\tUsers\nf\tnote.txt\nl\tlink\n", "C:\\", "windows");

    expect(entries.map((entry) => entry.path)).toEqual(["C:\\Users", "C:\\note.txt", "C:\\link"]);
    expect(entries[2]?.isSymbolicLink).toBe(true);
  });

  it("keeps POSIX entries unchanged", () => {
    const entries = parseFindEntries("d\troot\n", "/", "posix");

    expect(entries[0]?.path).toBe("/root");
  });
});

describe("Windows command shapes", () => {
  it("reads directories with Get-ChildItem and a tab separator", () => {
    const script = buildReaddirScript("C:\\Users", true, "windows");

    expect(script).toContain("Get-ChildItem -LiteralPath 'C:\\Users'");
    expect(script).toContain("$_.LinkType");
    expect(script).toContain("`t");
  });

  it("stats with Get-Item and unix seconds", () => {
    const script = buildStatScript("C:\\Users\\a.txt", "windows");

    expect(script).toContain("Get-Item -LiteralPath 'C:\\Users\\a.txt'");
    expect(script).toContain("ToUnixTimeSeconds");
  });
});

describe("probeSshRemotePlatform", () => {
  const result = (stdout: string, code = 0) => ({
    code,
    stdout: Buffer.from(stdout, "utf8"),
    stderr: "",
  });

  it("reports posix when PowerShell is missing but uname answers", async () => {
    const platform = await probeSshRemotePlatform(spec, async (_spec, command) =>
      command === "uname -s" ? result("Linux\n") : result("", 127),
    );

    expect(platform).toBe("posix");
  });

  it("reports windows when PowerShell answers", async () => {
    const platform = await probeSshRemotePlatform(spec, async () => result("Windows_NT\n"));

    expect(platform).toBe("windows");
  });

  it("keeps windows even when uname exists (Git for Windows on PATH)", async () => {
    // 装了 Git for Windows / MSYS2 的 Windows 上 uname 会返回 MINGW64_NT；
    // 先看 uname 就会把整台 Windows 判成 posix，之后每条命令都失败。
    const platform = await probeSshRemotePlatform(spec, async (_spec, command) =>
      command === "uname -s" ? result("MINGW64_NT-10.0\n") : result("Windows_NT\n"),
    );

    expect(platform).toBe("windows");
  });

  it("falls back to posix when neither probe answers", async () => {
    const platform = await probeSshRemotePlatform(spec, async () => {
      throw new Error("ssh missing");
    });

    expect(platform).toBe("posix");
  });
});

describe("sshDestinationArgs with a proxy tunnel", () => {
  const proxied: SshRemoteSpec = {
    host: "82.118.28.109",
    port: 49615,
    username: "root",
    alias: "56idc-jp",
    remotePath: "/root",
    proxy: { kind: "socks5", host: "127.0.0.1", port: 7897 },
  };

  it("keeps an alias but points ssh at the local tunnel port", () => {
    const args = sshDestinationArgs(proxied, { host: "127.0.0.1", port: 45123 });

    expect(args).toContain("HostName=127.0.0.1");
    expect(args).toContain("Port=45123");
    // known_hosts 必须仍按远端主机记账，否则所有代理主机共用 127.0.0.1 条目。
    expect(args).toContain("HostKeyAlias=82.118.28.109");
    expect(args.at(-1)).toBe("56idc-jp");
    // 命令行里出现 user@host 会覆盖 -o HostName，把连接拉回真实地址绕开代理。
    expect(args.join(" ")).not.toContain("root@82.118.28.109");
  });

  it("uses user@127.0.0.1 and -p without an alias", () => {
    const args = sshDestinationArgs(
      { ...proxied, alias: undefined },
      { host: "127.0.0.1", port: 45123 },
    );

    expect(args).toContain("-p");
    expect(args).toContain("45123");
    expect(args.at(-1)).toBe("root@127.0.0.1");
    expect(args).toContain("HostKeyAlias=82.118.28.109");
  });

  it("keeps the direct target when no tunnel is given", () => {
    const args = sshDestinationArgs({ ...proxied, alias: undefined });

    expect(args.at(-1)).toBe("root@82.118.28.109");
    expect(args).toContain("-p");
    expect(args).toContain("49615");
    expect(args.join(" ")).not.toContain("HostKeyAlias");
  });
});
