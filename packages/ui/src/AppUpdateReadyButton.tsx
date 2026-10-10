import { useEffect, useState } from "react";
import type { AppUpdateSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function AppUpdateReadyButton() {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const requestConfirmation = useConfirmDialog();
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(null);
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

  if (snapshot?.phase !== "downloaded" || snapshot.installKind || !downloadAppUpdate) return null;

  const handleClick = () => {
    void (async () => {
      const version = snapshot.latestVersion?.replace(/^v/i, "") ?? "";
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
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="[app-region:no-drag]"
      onClick={handleClick}
    >
      {intl.formatMessage({ id: "appUpdate.action" })}
    </Button>
  );
}
