import { spawn } from "node:child_process";

export interface SshRemoteSpec {
  alias?: string;
  host: string;
  port?: number;
  username: string;
  remotePath: string;
}

const targets = new Map<string, string>();
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export function rememberSshWorkspaceTarget(workspaceIdentity: string, spec: SshRemoteSpec): void {
  targets.set(workspaceIdentity, JSON.stringify(spec));
}

export function forgetSshWorkspaceTarget(workspaceIdentity: string): void {
  targets.delete(workspaceIdentity);
}

export function sshWorkspaceSpawnEnv(
  workspaceIdentity: string | undefined,
): Record<string, string> {
  const raw = workspaceIdentity ? targets.get(workspaceIdentity) : undefined;
  return raw ? { ZCODE_SSH_REMOTE: raw } : {};
}

export function sshSpecFromConnectTarget(
  target: { host: string; port?: number; username: string; sshConfigAlias?: string },
  remotePath: string,
): SshRemoteSpec {
  const alias = target.sshConfigAlias?.trim();
  return {
    host: target.host,
    username: target.username,
    remotePath,
    ...(target.port ? { port: target.port } : {}),
    ...(alias ? { alias } : {}),
  };
}

export function quotePosixArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Pi 在 Windows 上会把远端绝对路径解析成盘符路径。按远端根切回去。 */
export function remotePosixPath(resolved: string, remoteRoot: string): string {
  const root = remoteRoot.replaceAll("\\", "/").replace(/\/+$/u, "") || "/";
  const normalized = resolved.replaceAll("\\", "/");
  const atRoot = normalized.indexOf(root);
  if (root !== "/" && atRoot >= 0) return normalized.slice(atRoot);
  const stripped = normalized.replace(/^[A-Za-z]:/u, "");
  if (stripped.startsWith("/")) return stripped;
  return `${root}/${stripped.replace(/^\/+/u, "")}`;
}

export function sshDestinationArgs(spec: SshRemoteSpec): string[] {
  const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15"];
  const alias = spec.alias?.trim();
  if (alias) {
    args.push(alias);
    return args;
  }
  const port = spec.port ?? 22;
  if (port !== 22) args.push("-p", String(port));
  args.push(`${spec.username}@${spec.host}`);
  return args;
}

export function parseFindEntries(
  stdout: string,
  dir: string,
): Array<{ name: string; path: string; type: "file" | "directory"; isSymbolicLink: boolean }> {
  const base = dir.replace(/\/+$/u, "") || "/";
  const entries = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab <= 0) continue;
    const kind = line.slice(0, tab);
    const name = line.slice(tab + 1);
    if (!name || name === "." || name === "..") continue;
    entries.push({
      name,
      path: base === "/" ? `/${name}` : `${base}/${name}`,
      type: kind === "d" ? ("directory" as const) : ("file" as const),
      isSymbolicLink: kind === "l",
    });
  }
  return entries;
}

export async function runSsh(
  spec: SshRemoteSpec,
  remoteCommand: string,
  options?: { stdin?: Buffer; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const child = spawn("ssh", [...sshDestinationArgs(spec), remoteCommand], { windowsHide: true });
  const out: Buffer[] = [];
  let size = 0;
  let stderr = "";
  let settled = false;
  const kill = () => {
    child.kill();
  };
  options?.signal?.addEventListener("abort", kill, { once: true });
  return await new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: { code: number | null; stdout: Buffer; stderr: string }) => {
      if (settled) return;
      settled = true;
      options?.signal?.removeEventListener("abort", kill);
      if (error) reject(error);
      else resolve(result!);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STDOUT_BYTES) {
        kill();
        finish(new Error("ssh output exceeded 8 MiB"));
        return;
      }
      out.push(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => finish(undefined, { code, stdout: Buffer.concat(out), stderr }));
    if (options?.stdin) child.stdin?.end(options.stdin);
    else child.stdin?.end();
  });
}
