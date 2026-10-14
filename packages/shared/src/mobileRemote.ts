import { z } from "zod";

/** 当前窗口已打开的工作区。只给手机挂接调度用，不是任务或快照。 */
export const windowWorkspaceCatalogEntrySchema = z
  .object({
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1),
  })
  .strict();

export type WindowWorkspaceCatalogEntry = z.infer<typeof windowWorkspaceCatalogEntrySchema>;

export const windowWorkspaceCatalogSchema = z.array(windowWorkspaceCatalogEntrySchema).max(100);

export type MobileRemoteFirewallState = "allowed" | "prompted" | "blocked";

/** 手机远程控制的默认监听端口。用户没改过设置时一直用它，不每次随机。 */
export const MOBILE_REMOTE_DEFAULT_PORT = 47321;

export function parseMobileRemotePort(value: unknown): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const port = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

export function resolveMobileRemoteListenPort(value: unknown): number | null {
  if (value == null || value === "") return MOBILE_REMOTE_DEFAULT_PORT;
  return parseMobileRemotePort(value);
}

export type MobileRemotePairingStatus =
  | { status: "ready"; url: string; firewall?: MobileRemoteFirewallState }
  | { status: "unavailable"; reason: "no-lan-address" | "port-in-use" | "invalid-port" };

export interface MobileRemoteWorkspaceListItem {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  label: string;
  kind: "local" | "remote";
}
