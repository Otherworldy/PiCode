import { useCallback, useRef, useState } from "react";
import type { IZCodeAgentService } from "@picode/services";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { toast } from "@/components/ui/toast.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useZCodeSessionStore } from "@/store/picodeSessionStore.js";
import { useSessionResourceStore } from "@/store/sessionResourceStore.js";
import { ensureAgentV4ConnectionHandshake } from "@/v4/agentV4ConnectionHandshake.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";

export async function reloadCurrentSessionResources(params: {
  agentService: IZCodeAgentService;
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}) {
  await ensureAgentV4ConnectionHandshake(params.agentService);
  const ack = await params.agentService.sendConversationCommandV4({
    workspacePath: params.workspacePath,
    ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
    envelope: createCommandEnvelope({
      type: "reloadSession",
      sessionId: params.sessionId,
      payload: {},
    }),
  });
  // ACK failed 也会正常 resolve；必须核验完成结果才能刷新目录和提示成功。
  if (
    (ack.status !== "accepted" && ack.status !== "duplicate") ||
    ack.result?.type !== "reloadSession"
  ) {
    throw Object.assign(new Error(ack.message || ack.reasonCode || ack.status), {
      reasonCode: ack.reasonCode,
    });
  }
  return ack.result.slashCommands;
}

export function useCurrentSessionReload(params: {
  intl: IntlInstance;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const { intl, workspacePath, workspaceIdentity, remoteSessionId } = params;
  const services = useWorkspaceServices(workspacePath, remoteSessionId, workspaceIdentity);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const reload = useCallback(
    async (sessionId: string) => {
      if (pendingRef.current) return;
      pendingRef.current = true;
      setPending(true);
      try {
        const slashCommands = await reloadCurrentSessionResources({
          agentService: services.zcodeAgentService,
          workspacePath,
          workspaceIdentity,
          sessionId,
        });
        const store = useZCodeSessionStore.getState();
        // 用户可能在等待 ACK 时换会话；workspace 级 slashCommands 只允许回填原会话。
        if (store.getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId === sessionId) {
          store.setSlashCommands(workspacePath, slashCommands, workspaceIdentity);
        }
        useSessionResourceStore.getState().invalidate(workspacePath, workspaceIdentity, sessionId);
        toast(intl.formatMessage({ id: "appHeader.reloadSessionSuccess" }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const reasonCode = (error as { reasonCode?: unknown } | null)?.reasonCode;
        logger.warn("[session-reload] 重载失败", { sessionId, reason });
        toast(
          intl.formatMessage(
            { id: "appHeader.reloadSessionFailedReason" },
            {
              reason:
                reasonCode === "guard.sessionReloadBusy"
                  ? intl.formatMessage({ id: "appHeader.reloadSessionBusy" })
                  : reason,
            },
          ),
        );
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [intl, services, workspacePath, workspaceIdentity],
  );
  return { pending, reload };
}
