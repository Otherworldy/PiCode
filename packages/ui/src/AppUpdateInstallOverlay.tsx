import { useEffect, useState } from "react";
import type { AppUpdateSnapshot } from "@zcode/shared";
import { Spinner } from "@/components/ui/spinner.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 静默安装前的等待态。
 *
 * 主进程在 `installing` 阶段会停留 2.5 秒再退出，这段时间界面必须说明「会关闭、
 * 大概多久、会自动重开」；否则窗口直接消失，用户只会看到长时间空屏。
 * 只有 Windows 会静默安装并长时间消失：macOS 只打开安装盘，Linux 替换后立即重启。
 */
export function AppUpdateInstallOverlay({
  initialSnapshot,
}: {
  initialSnapshot?: AppUpdateSnapshot | null;
} = {}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(initialSnapshot ?? null);
  const getAppUpdateState = platform.getAppUpdateState;
  const onAppUpdateStateChanged = platform.onAppUpdateStateChanged;
  // 安装器接管后主进程还要几秒才真正退出，这期间不能再放回可交互的界面。
  const installing =
    snapshot?.phase === "installing" ||
    (snapshot?.phase === "downloaded" && snapshot.installKind === "quit-for-installer");

  useEffect(() => {
    if (!getAppUpdateState) return;
    let cancelled = false;
    const apply = (next: AppUpdateSnapshot) => {
      if (!cancelled) setSnapshot(next);
    };
    const dispose = onAppUpdateStateChanged?.(apply);
    void getAppUpdateState()
      .then(apply)
      .catch(() => undefined);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [getAppUpdateState, onAppUpdateStateChanged]);

  if (!installing || !/Win/i.test(navigator.platform)) return null;

  return (
    <div
      className="fixed inset-0 z-[1000] flex flex-col items-center justify-center gap-3 bg-background/95 text-center backdrop-blur-sm"
      role="status"
      aria-busy
      data-testid="app-update-installing-overlay"
    >
      <Spinner className="size-8 text-foreground-subtle" />
      <h2 className="text-ui-lg font-medium">
        {intl.formatMessage({ id: "appUpdate.installing.title" })}
      </h2>
      <p className="max-w-md text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "appUpdate.installing.description" })}
      </p>
      <p className="max-w-md text-ui-caption text-foreground-subtle">
        {intl.formatMessage({ id: "appUpdate.installing.hint" })}
      </p>
    </div>
  );
}
