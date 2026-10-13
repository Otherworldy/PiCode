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

export type MobileRemotePairingStatus =
  | { status: "ready"; url: string; firewall?: MobileRemoteFirewallState }
  | { status: "unavailable"; reason: "no-lan-address" };

export interface MobileRemoteWorkspaceListItem {
  workspaceKey: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  label: string;
  kind: "local" | "remote";
}
