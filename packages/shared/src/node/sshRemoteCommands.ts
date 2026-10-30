/**
 * SSH 远端命令构造：同一份语义提供 POSIX shell 与 Windows PowerShell 两个版本。
 *
 * 只放纯函数（输入路径 → 命令字符串 / 输出 → 数据），方便单测覆盖命令形状。
 * 实际执行仍在 sshWorkspaceFileService.ts。
 *
 * Windows 侧的约定：
 * - 所有命令都由 buildRemoteShellCommand 包成 `powershell -EncodedCommand`，
 *   因此外层 shell 是 cmd 还是 PowerShell 都不影响引号解析。
 * - PowerShell 同时接受 `/` 和 `\`，所以内部路径可以混用分隔符；
 *   只有 readdir 的返回路径统一用 `\`，与用户看到的 Windows 路径一致。
 * - 二进制一律 base64 出入，避免管道编码把字节改坏。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRemoteShellCommand,
  quotePosixArg,
  quoteRemoteArg,
  remoteDirname,
  runSsh,
  sshAskpassEnv,
  sshPasswordFileOf,
  sshTunnelEndpoint,
  type SshRemotePlatform,
  type SshRemoteSpec,
} from "./sshRemote.js";

/** 面板/发行版环境里常见的开发根目录；`$HOME` 不可用时的后备。 */
const REMOTE_START_DIRECTORY_FALLBACKS = [
  "/www/wwwroot",
  "/var/www",
  "/opt",
  "/srv",
  "/home",
] as const;

export function buildRemoteStartDirectoryScript(platform: SshRemotePlatform): string {
  if (platform === "windows") {
    // USERPROFILE 是 PowerShell 里的当前用户主目录；缺失时退到系统盘根。
    return String.raw`if ($env:USERPROFILE) { $env:USERPROFILE } else { $env:SystemDrive + '\' }`;
  }
  const candidates = REMOTE_START_DIRECTORY_FALLBACKS.map((path) => quotePosixArg(path)).join(" ");
  // 只读探测：$HOME 优先，其次常见开发目录，都没有就回 /。
  return [
    'if [ -d "$HOME" ]; then printf %s "$HOME";',
    `else for d in ${candidates}; do [ -d "$d" ] && { printf %s "$d"; break; }; done; fi`,
  ].join(" ");
}

/** 起始目录探测结果：不合法/相对路径按平台回退到根。 */
export function normalizeRemoteStartDirectory(raw: string, platform: SshRemotePlatform): string {
  const candidate = raw.trim();
  if (platform === "windows") {
    return /^[A-Za-z]:[\\/]/u.test(candidate) ? candidate.replaceAll("/", "\\") : "C:\\";
  }
  return candidate.startsWith("/") ? candidate : "/";
}

export function buildReaddirScript(
  dir: string,
  includeHidden: boolean,
  platform: SshRemotePlatform,
): string {
  if (platform === "windows") {
    // LinkType 非空即重解析点（符号链接/联接），对应 POSIX 的 `%y = l`。
    // -Force 才能列出隐藏项；Windows 没有 POSIX 点文件约定，includeHidden 在这里不生效。
    return `Get-ChildItem -LiteralPath ${quoteRemoteArg(dir, "windows")} -Force -ErrorAction Stop | ForEach-Object { $k = if ($_.PSIsContainer) {'d'} elseif ($_.LinkType) {'l'} else {'f'}; "$k\`t$($_.Name)" }`;
  }
  const hidden = includeHidden === false ? " ! -name '.*'" : "";
  return `find ${quotePosixArg(dir)} -mindepth 1 -maxdepth 1${hidden} -printf '%y\\t%f\\n'`;
}

export function buildStatScript(path: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    return String.raw`$i = Get-Item -LiteralPath ${quoteRemoteArg(path, "windows")} -Force -ErrorAction Stop; "$(if ($i.PSIsContainer) {'directory'} else {'file'})|$($i.Length)|$([DateTimeOffset]::new($i.LastWriteTimeUtc).ToUnixTimeSeconds())"`;
  }
  return `stat -c '%F|%s|%Y' -- ${quotePosixArg(path)}`;
}

export function parseRemoteStat(
  text: string,
  path: string,
): { path: string; type: "file" | "directory"; size: number; mtimeMs: number } {
  const [kind, size, mtime] = text.trim().split("|");
  return {
    path,
    type: kind === "directory" ? "directory" : "file",
    size: Number(size),
    mtimeMs: Number(mtime) * 1000,
  };
}

export function buildExistsScript(paths: readonly string[], platform: SshRemotePlatform): string {
  if (platform === "windows") {
    return paths
      .map(
        (path) =>
          `if (Test-Path -LiteralPath ${quoteRemoteArg(path, "windows")}) { '1' } else { '0' }`,
      )
      .join("; ");
  }
  return paths
    .map((path) => `if test -e ${quotePosixArg(path)}; then echo 1; else echo 0; fi`)
    .join("; ");
}

export function buildResolvePathScript(path: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    return String.raw`(Get-Item -LiteralPath ${quoteRemoteArg(path, "windows")} -Force -ErrorAction Stop).FullName`;
  }
  return `readlink -f -- ${quotePosixArg(path)}`;
}

/**
 * 读取文件片段。
 *
 * Windows 侧输出 base64：PowerShell 的 stdout 编码由控制台决定，
 * 直接把字节写进管道会被转码；base64 是纯 ASCII，解码后才还原原始字节。
 */
export function buildReadRangeScript(
  path: string,
  offset: number,
  length: number,
  platform: SshRemotePlatform,
): string {
  if (platform === "windows") {
    const quoted = quoteRemoteArg(path, "windows");
    // FileStream.Read 允许短读，必须循环到读满或 EOF，否则调用方会静默拿到偏少的字节。
    return String.raw`$fs = [IO.File]::OpenRead(${quoted}); try { $fs.Position = ${offset}; $buf = New-Object byte[] ${length}; $n = 0; while ($n -lt ${length}) { $read = $fs.Read($buf, $n, ${length} - $n); if ($read -le 0) { break }; $n += $read } } finally { $fs.Close() }; [Convert]::ToBase64String($buf, 0, $n)`;
  }
  return `dd if=${quotePosixArg(path)} iflag=skip_bytes,count_bytes skip=${offset} count=${length} status=none`;
}

/** 读取整段文本（agent prompt / SYSTEM.md）。Windows 侧按 UTF-8 解码，BOM 由调用方剥。 */
export function buildReadTextScript(path: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    // 必须用 Console.Out.Write：直接把字符串作为脚本结果输出时，PowerShell 会补一个换行，
    // 读回来的内容比文件多一行，编辑保存会让文件每轮增长。
    return String.raw`[Console]::Out.Write([IO.File]::ReadAllText(${quoteRemoteArg(path, "windows")}, [System.Text.Encoding]::UTF8))`;
  }
  return `cat -- ${quotePosixArg(path)}`;
}

/**
 * POSIX 写文件：内容走 stdin 原始字节，不做文本转码。
 *
 * Windows 不用这条：stdin 大内容会被外层 PowerShell 缓冲到挂死，改走 scp
 * （见 writeSshFileContent）。
 */
export function buildWriteFileScript(path: string, directory: string): string {
  return `mkdir -p ${quotePosixArg(directory)} && cat > ${quotePosixArg(path)}`;
}

export function buildRemoveFileScript(path: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    return `Remove-Item -LiteralPath ${quoteRemoteArg(path, "windows")} -Force -ErrorAction SilentlyContinue`;
  }
  return `rm -f -- ${quotePosixArg(path)}`;
}

/** 文件是否存在；不存在时输出为空。 */
export function buildIsFileScript(path: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    return String.raw`if (Test-Path -LiteralPath ${quoteRemoteArg(path, "windows")} -PathType Leaf) { 'yes' }`;
  }
  return `if test -f ${quotePosixArg(path)}; then printf yes; fi`;
}

/** 列出目录下的 `*.md` 文件名；目录不存在时输出为空。 */
export function buildListMarkdownScript(directory: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    const quoted = quoteRemoteArg(directory, "windows");
    return String.raw`if (Test-Path -LiteralPath ${quoted} -PathType Container) { Get-ChildItem -LiteralPath ${quoted} -Filter *.md -File -Force | ForEach-Object { $_.Name } }`;
  }
  return `if test -d ${quotePosixArg(directory)}; then find ${quotePosixArg(directory)} -mindepth 1 -maxdepth 1 -type f -name '*.md' -printf '%f\\n'; fi`;
}

/** 目录浏览器把任意路径当根时的父目录回退值。 */
export function remoteRootPath(platform: SshRemotePlatform): string {
  return platform === "windows" ? "C:\\" : "/";
}

/**
 * PowerShell 脚本的退出码后缀。
 *
 * ssh 只看 powershell.exe 的退出码，而脚本最后一条是 cmdlet 时它恒为 0；
 * 原生 exe（git、npm）的退出码在 $LASTEXITCODE 里，cmdlet 成败看 $?。
 */
const WINDOWS_EXIT_SUFFIX =
  "; if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE } elseif ($?) { exit 0 } else { exit 1 }";

/** 创建目录（幂等）。 */
export function buildMkdirScript(directory: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    return `New-Item -ItemType Directory -Force -Path ${quoteRemoteArg(directory, "windows")} -ErrorAction Stop | Out-Null`;
  }
  return `mkdir -p ${quotePosixArg(directory)}`;
}

/** 列出目录下的直接子项名称（不区分文件/目录）。 */
export function buildListNamesScript(directory: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    return `Get-ChildItem -LiteralPath ${quoteRemoteArg(directory, "windows")} -Force -ErrorAction Stop | ForEach-Object { $_.Name }`;
  }
  return `find ${quotePosixArg(directory)} -mindepth 1 -maxdepth 1 -printf '%f\\n'`;
}

/**
 * 文件可访问性检查，结果走退出码（0 = 可访问）。
 *
 * Windows 侧只校验存在性与是否目录：ACL 级可写判定需要另起一次 .NET 调用，
 * 代价大于收益，真正写入失败时写入命令自己会报错。
 */
export function buildAccessScript(
  path: string,
  mode: "read" | "readwrite",
  platform: SshRemotePlatform,
): string {
  if (platform === "windows") {
    return `if (Test-Path -LiteralPath ${quoteRemoteArg(path, "windows")} -PathType Leaf) { exit 0 } else { exit 1 }`;
  }
  const quoted = quotePosixArg(path);
  return mode === "read" ? `test -r ${quoted}` : `test -r ${quoted} && test -w ${quoted}`;
}

/** 判断路径是否是目录，结果走退出码（0 = 是目录，1 = 不是）。 */
export function buildIsDirectoryExitScript(path: string, platform: SshRemotePlatform): string {
  if (platform === "windows") {
    return `if (Test-Path -LiteralPath ${quoteRemoteArg(path, "windows")} -PathType Container) { exit 0 } else { exit 1 }`;
  }
  return `test -d ${quotePosixArg(path)}`;
}

/**
 * agent 的 bash 工具：在远端 cwd 下执行一段命令。
 *
 * Windows 侧命令体是模型写的 PowerShell，不能直接拼进外层命令行（会被解析两次）；
 * 整段连同 Set-Location 一起交给 EncodedCommand，并把退出码带回来。
 */
export function buildRemoteCommandScript(
  command: string,
  cwd: string,
  platform: SshRemotePlatform,
): string {
  if (platform === "windows") {
    // -ErrorAction Stop：Set-Location 失败默认只是 non-terminating error，脚本会继续
    // 在默认目录（用户主目录）执行命令，rm/git 就会作用到错误位置。
    return `Set-Location -LiteralPath ${quoteRemoteArg(cwd, "windows")} -ErrorAction Stop; ${command}${WINDOWS_EXIT_SUFFIX}`;
  }
  return `cd ${quotePosixArg(cwd)} && ${command}`;
}

/**
 * 上传本地文件到远端（scp）。
 *
 * Windows 远端写大内容不能走 ssh stdin：DefaultShell 是 PowerShell 时，
 * 外层 PowerShell 会缓冲子进程 stdin，实测超过约 4KB 整条连接挂死。
 * scp 走独立通道，无命令行长度与 stdin 缓冲问题；远端路径统一用正斜杠。
 */
export async function spawnScp(
  spec: SshRemoteSpec,
  localPath: string,
  remotePath: string,
): Promise<ChildProcess> {
  const hasPassword = sshPasswordFileOf(spec) !== undefined;
  const args = [
    "-q",
    "-o",
    hasPassword ? "BatchMode=no" : "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (hasPassword) {
    args.push(
      "-o",
      "PreferredAuthentications=password,keyboard-interactive",
      "-o",
      "PubkeyAuthentication=no",
      "-o",
      "NumberOfPasswordPrompts=1",
    );
  }
  // 走代理时 scp 与 ssh 共用同一个本地转发端口，主机名只留给 HostKeyAlias。
  const tunnel = await sshTunnelEndpoint(spec);
  // 别名连接时目标只写别名：HostName/Port/User/ProxyJump 都在 ssh_config 里，
  // 拼 username@host 会绕开这些配置，连到和 ssh 命令不同的端点。
  const alias = spec.alias?.trim();
  if (tunnel) {
    args.push("-o", `HostKeyAlias=${spec.host}`);
    if (alias) {
      args.push(
        "-o",
        `HostName=${tunnel.host}`,
        "-o",
        `Port=${tunnel.port}`,
        localPath,
        `${alias}:${remotePath}`,
      );
    } else {
      args.push(
        "-P",
        String(tunnel.port),
        localPath,
        `${spec.username}@${tunnel.host}:${remotePath}`,
      );
    }
  } else if (alias) {
    args.push(localPath, `${alias}:${remotePath}`);
  } else {
    const port = spec.port ?? 22;
    if (port !== 22) args.push("-P", String(port));
    args.push(localPath, `${spec.username}@${spec.host}:${remotePath}`);
  }
  return spawn("scp", args, {
    windowsHide: true,
    stdio: "pipe",
    env: await sshAskpassEnv(spec),
  });
}

/**
 * 写入远端文本文件。
 *
 * POSIX 走 stdin 原始字节；Windows 走 scp —— 外层 PowerShell 会缓冲子进程 stdin，
 * 实测超过约 4KB 整条连接挂死，而 scp 是独立通道且不受命令行长度限制。
 */
export async function writeSshFileContent(
  spec: SshRemoteSpec,
  path: string,
  content: string,
  runRemoteCommand: typeof runSsh = runSsh,
): Promise<void> {
  const platform: SshRemotePlatform = spec.platform === "windows" ? "windows" : "posix";
  const bytes = Buffer.from(content, "utf8");
  if (platform === "posix") {
    const result = await runRemoteCommand(
      spec,
      buildWriteFileScript(path, remoteDirname(path, platform) ?? "/"),
      { stdin: bytes },
    );
    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || "ssh write failed");
    }
    return;
  }
  const directory = remoteDirname(path, platform) ?? "C:\\";
  const mkdir = await runRemoteCommand(
    spec,
    buildRemoteShellCommand(buildMkdirScript(directory, platform), platform),
  );
  if (mkdir.code !== 0) {
    throw new Error(mkdir.stderr.trim() || "ssh mkdir failed");
  }
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "zcode-ssh-write-"));
  try {
    const localPath = join(temporaryDirectory, "payload.bin");
    await writeFile(localPath, bytes);
    const child = await spawnScp(spec, localPath, path.replaceAll("\\", "/"));
    const stderr = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        buffer = (buffer + chunk.toString("utf8")).slice(-4000);
      });
      // 读掉 stdout，避免管道写满后子进程阻塞。
      child.stdout?.on("data", () => undefined);
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve("");
        else resolve(buffer.trim() || `scp exited ${code ?? "null"}`);
      });
    });
    if (stderr) throw new Error(stderr);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}
