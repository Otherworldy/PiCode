import { useEffect, useMemo } from "react";
import { deriveDesktopPetMood, type DesktopPetMood, type IPlatformService } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";

type PetMoodPlatform = Pick<IPlatformService, "setDesktopPetMood">;

interface DesktopPetMoodParams {
  workspacePath: string;
  workspaceIdentity?: string;
  endpointKey?: string | null;
  enabled: boolean;
  platform: PetMoodPlatform | null | undefined;
}

function trimOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 把本窗口工作区的会话收成一种宠物心情。
 * 不看通知开关：心情不是提醒。工作区一换就退订旧列表。窗口关掉时上报待机，避免主进程留着旧心情。
 */
export function useDesktopPetMood({
  workspacePath,
  workspaceIdentity: rawWorkspaceIdentity,
  endpointKey: rawEndpointKey,
  enabled,
  platform,
}: DesktopPetMoodParams): void {
  const { zcodeAgentService } = useServices();
  const workspaceIdentity = trimOptional(rawWorkspaceIdentity);
  const endpointKey = trimOptional(rawEndpointKey);
  const workspaceKey = workspaceIdentity ?? workspacePath;
  const signature = useMemo(
    () => [endpointKey ?? "", workspaceKey, workspacePath].join("\0"),
    [endpointKey, workspaceKey, workspacePath],
  );

  useEffect(() => {
    if (!enabled || !platform?.setDesktopPetMood) return;
    const report = (mood: DesktopPetMood) => {
      try {
        platform.setDesktopPetMood?.(mood);
      } catch (error) {
        logger.warn("[desktop-pet] 心情上报失败", { mood, error });
      }
    };
    const registryScope: SessionsIndexScope = {
      workspaceKey,
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(endpointKey ? { endpointKey } : {}),
    };
    const store = acquireSessionsIndex(registryScope, zcodeAgentService);
    let lastMood: DesktopPetMood | null = null;
    const sync = () => {
      if (store.getStatus() !== "live") return;
      const mood = deriveDesktopPetMood(store.getSessions());
      if (mood === lastMood) return;
      lastMood = mood;
      report(mood);
    };
    const unsubscribe = store.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
      releaseSessionsIndex(registryScope, store);
      report("idle");
    };
  }, [
    enabled,
    endpointKey,
    platform,
    signature,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    zcodeAgentService,
  ]);
}
