import { useEffect, useState } from "react";
import type { AppUpdateSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function AppUpdateReadyButton({
  initialSnapshot,
}: {
  initialSnapshot?: AppUpdateSnapshot | null;
} = {}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(initialSnapshot ?? null);
  const getAppUpdateState = platform.getAppUpdateState;
  const onAppUpdateStateChanged = platform.onAppUpdateStateChanged;
  const downloadAppUpdate = platform.downloadAppUpdate;

  useEffect(() => {
    if (!getAppUpdateState) return;
    let cancelled = false;
    const apply = (next: AppUpdateSnapshot) => {
      if (!cancelled) setSnapshot(next);
    };
    const dispose = onAppUpdateStateChanged?.(apply);
    void getAppUpdateState().then(apply);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [getAppUpdateState, onAppUpdateStateChanged]);

  if (snapshot?.phase !== "downloaded" || snapshot.installKind || !downloadAppUpdate) {
    return null;
  }

  const handleClick = () => {
    void (async () => {
      const version = snapshot?.latestVersion?.replace(/^v/i, "") || "";
      const opensDiskImage = /Mac/i.test(navigator.platform);
      const confirmed = await requestConfirmation({
        title: intl.formatMessage({
          id: opensDiskImage ? "appUpdate.openTitle" : "appUpdate.restartTitle",
        }),
        description: intl.formatMessage(
          { id: opensDiskImage ? "appUpdate.openDescription" : "appUpdate.restartDescription" },
          { version },
        ),
        confirmLabel: intl.formatMessage({ id: "appUpdate.confirm" }),
        cancelLabel: intl.formatMessage({ id: "appUpdate.cancel" }),
      });
      if (!confirmed) return;
      await downloadAppUpdate();
    })();
  };

  return (
    // 桌面更新下载完成后，右上角更新按钮使用 #e6a23c 暖黄背景、白色文字与 13px(text-ui-caption) 字号。
    <Button
      type="button"
      size="sm"
      className="border-[#e6a23c] bg-[#e6a23c] text-ui-caption font-medium text-white shadow-xs hover:bg-[#ebb563] hover:text-white active:bg-[#cf9236] focus-visible:ring-[#e6a23c]/40 [app-region:no-drag]"
      onClick={handleClick}
    >
      {intl.formatMessage({ id: "appUpdate.action" })}
    </Button>
  );
}
