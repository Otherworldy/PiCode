import { useEffect, useRef, useState } from "react";
import type { ZCodeAgentToolCatalogEntry } from "@zcode/shared";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";

export interface AgentToolCatalogState {
  tools: ZCodeAgentToolCatalogEntry[];
  loading: boolean;
  error: string | null;
}

const EMPTY_STATE: AgentToolCatalogState = { tools: [], loading: false, error: null };

/**
 * 内置角色工具编辑器的候选项：workspace 级现扫 Pi 内置工具与用户包扩展工具。
 * 设置页没有活动会话，所以不带 sessionId；没有 workspace 时不请求，由调用方退回当前工具名。
 */
export function useAgentToolCatalog(options: {
  workspacePath: string;
  workspaceIdentity?: string;
  enabled: boolean;
}): AgentToolCatalogState {
  const { zcodeAgentService } = useBaseWorkspaceServices();
  const [state, setState] = useState<AgentToolCatalogState>(EMPTY_STATE);
  const requestSeqRef = useRef(0);
  const { enabled, workspacePath, workspaceIdentity } = options;

  useEffect(() => {
    if (!enabled || !workspacePath) {
      requestSeqRef.current += 1;
      setState(EMPTY_STATE);
      return;
    }
    const seq = ++requestSeqRef.current;
    let cancelled = false;
    setState({ tools: [], loading: true, error: null });
    zcodeAgentService
      .getAgentToolCatalog({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      })
      .then((result) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        setState({ tools: result.tools, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || seq !== requestSeqRef.current) return;
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("[useAgentToolCatalog] 拉取子智能体工具清单失败", { error: message });
        setState({ tools: [], loading: false, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, workspacePath, workspaceIdentity, zcodeAgentService]);

  return state;
}
