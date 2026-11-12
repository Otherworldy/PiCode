import { useCallback, useEffect, useRef, useState } from "react";
import type { IMemoryService, WorkspaceMemoryModelRef } from "@picode/services";

type MemoryConfigService = Pick<
  IMemoryService,
  | "getWorkspaceMemoryEnabled"
  | "setWorkspaceMemoryEnabled"
  | "getWorkspaceMemoryModel"
  | "setWorkspaceMemoryModel"
  | "getWorkspaceMemoryExpiryDays"
  | "setWorkspaceMemoryExpiryDays"
>;

type WorkspaceRef = { workspacePath: string; workspaceIdentity?: string };

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 项目记忆的三项项目级配置（开关、抽取模型、过期阈值）。
 *
 * 单独成 hook 是因为它们共享同一套「乐观更新 + 失败回滚 + 打开时重读」的写法，
 * 留在对话框里会把组件撑过 max-lines 且和文件编辑逻辑混在一起。
 */
export function useWorkspaceMemoryConfig({
  memoryService,
  open,
  remote,
  workspaceRef,
}: {
  memoryService: MemoryConfigService;
  open: boolean;
  remote: boolean;
  workspaceRef: WorkspaceRef;
}) {
  const requestIdRef = useRef(0);
  const [enabled, setEnabled] = useState(false);
  const [enabledLoading, setEnabledLoading] = useState(true);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [memoryModel, setMemoryModel] = useState<WorkspaceMemoryModelRef | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  // null 表示还在读取；真实值由 service 给出，UI 不复制默认阈值。
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [expiryError, setExpiryError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (remote) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    try {
      const [nextEnabled, nextModel, nextExpiryDays] = await Promise.all([
        memoryService.getWorkspaceMemoryEnabled(workspaceRef),
        memoryService.getWorkspaceMemoryModel(workspaceRef).catch(() => null),
        memoryService.getWorkspaceMemoryExpiryDays(workspaceRef).catch(() => null),
      ]);
      if (requestIdRef.current !== requestId) return;
      setEnabled(nextEnabled);
      setMemoryModel(nextModel);
      setExpiryDays(nextExpiryDays);
    } catch (error) {
      if (requestIdRef.current !== requestId) return;
      setSwitchError(getErrorMessage(error));
    } finally {
      if (requestIdRef.current === requestId) setEnabledLoading(false);
    }
  }, [memoryService, remote, workspaceRef]);

  useEffect(() => {
    if (!open) {
      requestIdRef.current += 1;
      setSwitchError(null);
      setModelError(null);
      setExpiryError(null);
      setExpiryDays(null);
      return;
    }
    if (remote) {
      setEnabledLoading(false);
      return;
    }
    setEnabledLoading(true);
    void reload();
  }, [open, reload, remote]);

  const updateEnabled = useCallback(
    async (next: boolean) => {
      if (remote) return;
      const previous = enabled;
      setEnabled(next);
      setSwitchError(null);
      try {
        await memoryService.setWorkspaceMemoryEnabled({ ...workspaceRef, enabled: next });
      } catch (error) {
        setEnabled(previous);
        setSwitchError(getErrorMessage(error));
      }
    },
    [enabled, memoryService, remote, workspaceRef],
  );

  const updateModel = useCallback(
    async (next: WorkspaceMemoryModelRef | null) => {
      if (remote) return;
      const previous = memoryModel;
      setMemoryModel(next);
      setModelError(null);
      try {
        await memoryService.setWorkspaceMemoryModel({ ...workspaceRef, model: next });
      } catch (error) {
        setMemoryModel(previous);
        setModelError(getErrorMessage(error));
      }
    },
    [memoryModel, memoryService, remote, workspaceRef],
  );

  const updateExpiryDays = useCallback(
    async (next: number) => {
      if (remote) return;
      const previous = expiryDays;
      setExpiryDays(next);
      setExpiryError(null);
      try {
        await memoryService.setWorkspaceMemoryExpiryDays({ ...workspaceRef, days: next });
      } catch (error) {
        setExpiryDays(previous);
        setExpiryError(getErrorMessage(error));
      }
    },
    [expiryDays, memoryService, remote, workspaceRef],
  );

  return {
    enabled,
    enabledLoading,
    expiryDays,
    expiryError,
    memoryModel,
    modelError,
    reload,
    setEnabled: updateEnabled,
    setExpiryDays: updateExpiryDays,
    setModel: updateModel,
    switchError,
  };
}
