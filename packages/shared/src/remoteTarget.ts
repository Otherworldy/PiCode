import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";

/**
 * 远端 shell 家族。
 *
 * 由 Host 在连接阶段探测后填入 target，不从 UI 提交，也不写进历史快照：
 * 重连时会重新探测，避免旧快照把一台重装过系统的机器钉在错误的 shell 上。
 */
export type SshRemotePlatform = "posix" | "windows";

export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
  /** 探测结果，缺省按 posix（兼容旧快照与旧 Host）。 */
  platform?: SshRemotePlatform;
}

export interface WSLConnectOptions {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerConnectOptions {
  kind: "docker";
  container: string;
}

export type RemoteTarget = SSHConnectOptions | WSLConnectOptions | DockerConnectOptions;

/**
 * 删除只应存在于当前连接流程中的字段，供长期内存状态和跨进程回包使用。
 *
 * password/私钥口令是 secret；platform 是 Host 连接期探测结果，
 * 下发给 renderer 只会和每次连接重新探测的值冲突，所以一起剥掉。
 */
export function stripRemoteTargetSecrets(target: RemoteTarget): RemoteTarget {
  if (target.kind === "ssh") {
    const {
      password: _password,
      privateKeyPassphrase: _privateKeyPassphrase,
      platform: _platform,
      ...sanitized
    } = target;
    return sanitized;
  }

  return target;
}
