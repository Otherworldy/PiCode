import { useEffect } from "react";
import { toast } from "@/components/ui/toast.js";
import { useZCodeSessionService } from "@/hooks/useZCodeSessionService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  piPluginUpdateCacheIsFresh,
  piPluginUpdateCheckDelay,
  piPluginUpdateWorkspaceKey,
} from "@/lib/piPluginUpdateCheck.js";
import { logger } from "@/logger.js";
import { usePiPluginUpdateStore, type PiPluginUpdate } from "@/store/piPluginUpdateStore.js";

/** 启动后按缓存时间自动检查当前工作区，只有发现可更新才提示。 */
export function usePiPluginUpdateWatch(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  rpcReady: boolean,
): void {
  const session = useZCodeSessionService(workspacePath, null, workspaceIdentity);
  const { intl } = useZCodeIntl();
  const workspaceKey = piPluginUpdateWorkspaceKey(workspacePath, workspaceIdentity);

  useEffect(() => {
    if (!rpcReady || !workspacePath) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const workspace = {
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
    };
    const apply = (result: { updates?: PiPluginUpdate[]; updatesCheckedAt?: number }) => {
      usePiPluginUpdateStore
        .getState()
        .apply(workspaceKey, result.updates ?? [], result.updatesCheckedAt);
    };
    const schedule = (checkedAt: number | undefined) => {
      timer = setTimeout(
        () => {
          void run();
        },
        piPluginUpdateCheckDelay(checkedAt, Date.now()),
      );
    };
    const run = async () => {
      try {
        const listed = await session.mutatePiPlugins({ ...workspace, action: "list" });
        if (cancelled) return;
        apply(listed);
        if (piPluginUpdateCacheIsFresh(listed.updatesCheckedAt, Date.now())) {
          schedule(listed.updatesCheckedAt);
          return;
        }
        const result = await session.mutatePiPlugins({ ...workspace, action: "checkUpdates" });
        if (cancelled) return;
        apply(result);
        const count = result.updates?.length ?? 0;
        if (count > 0) {
          toast(intl.formatMessage({ id: "settings.plugins.checkForUpdates.found" }, { count }));
        }
        schedule(result.updatesCheckedAt ?? Date.now());
      } catch (error) {
        if (cancelled) return;
        logger.warn("[pi-plugins] update check failed", { error });
        schedule(Date.now());
      }
    };
    void run();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intl, rpcReady, session, workspaceIdentity, workspaceKey, workspacePath]);
}
