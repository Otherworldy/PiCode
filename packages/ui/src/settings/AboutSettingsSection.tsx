import { useEffect, useState } from "react";
import { ZCODE_VERSION, type AppUpdateSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

export function AboutSettingsSection() {
  const { intl } = useZCodeIntl();
  const { getAppUpdateState, checkAppUpdate, onAppUpdateStateChanged, downloadAppUpdate } =
    usePlatform();
  const canUpdate = typeof checkAppUpdate === "function";
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(null);

  useEffect(() => {
    if (!canUpdate || !getAppUpdateState || !checkAppUpdate) return;
    let cancelled = false;
    const apply = (next: AppUpdateSnapshot) => {
      if (!cancelled) setSnapshot(next);
    };
    const dispose = onAppUpdateStateChanged?.(apply);
    void getAppUpdateState().then(apply);
    void checkAppUpdate().then(apply);
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [canUpdate, getAppUpdateState, checkAppUpdate, onAppUpdateStateChanged]);

  const version = snapshot?.currentVersion || ZCODE_VERSION;
  const progress = formatProgress(snapshot);
  const busy =
    snapshot?.phase === "checking" ||
    snapshot?.phase === "downloading" ||
    snapshot?.phase === "installing";
  const canInstall =
    snapshot?.phase === "available" ||
    snapshot?.phase === "downloaded" ||
    (snapshot?.phase === "error" &&
      snapshot.errorCode !== "unpackaged" &&
      snapshot.errorCode !== "no-asset" &&
      snapshot.assetName !== undefined);

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.about.version" })}
          description={
            snapshot?.phase === "upToDate"
              ? intl.formatMessage(
                  { id: "settings.about.versionStatus" },
                  {
                    version,
                    status: intl.formatMessage({ id: "settings.about.upToDate" }),
                  },
                )
              : version
          }
          control={
            canUpdate ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  const action = canInstall ? downloadAppUpdate : checkAppUpdate;
                  if (!action) return;
                  void action().then(setSnapshot);
                }}
              >
                {buttonLabel(intl, snapshot, canInstall)}
              </Button>
            ) : (
              <span />
            )
          }
        />
      </SettingsGroupCard>
      {snapshot?.phase === "downloading" ? (
        <div className="h-1.5 overflow-hidden rounded-full bg-surface">
          <div className="h-full bg-foreground" style={{ width: `${progress.percent ?? 0}%` }} />
        </div>
      ) : null}
      <StatusText snapshot={snapshot} canUpdate={canUpdate} />
    </div>
  );
}

function StatusText({
  snapshot,
  canUpdate,
}: {
  snapshot: AppUpdateSnapshot | null;
  canUpdate: boolean;
}) {
  const { intl } = useZCodeIntl();
  if (!canUpdate) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.about.desktopOnly" })}
      </p>
    );
  }
  if (!snapshot || snapshot.phase === "idle" || snapshot.phase === "checking") return null;
  if (snapshot.phase === "error" && snapshot.errorCode) {
    return (
      <p className="text-ui-base text-destructive">
        {intl.formatMessage({ id: `settings.about.error.${snapshot.errorCode}` })}
      </p>
    );
  }
  const message =
    snapshot.phase === "upToDate"
      ? null
      : snapshot.phase === "available"
        ? intl.formatMessage(
            { id: "settings.about.available" },
            { version: displayVersion(snapshot.latestVersion) },
          )
        : snapshot.installKind === "opened-installer"
          ? intl.formatMessage({ id: "settings.about.openedHint" })
          : snapshot.installKind === "relaunch"
            ? intl.formatMessage({ id: "settings.about.relaunchHint" })
            : snapshot.installKind === "quit-for-installer"
              ? intl.formatMessage({ id: "settings.about.quitHint" })
              : null;
  return (
    <div className="space-y-3">
      {message ? <p className="text-ui-base text-foreground-subtle">{message}</p> : null}
      {snapshot.notes ? (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-ui-base text-foreground-subtle">
          {snapshot.notes}
        </pre>
      ) : null}
    </div>
  );
}

function buttonLabel(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  snapshot: AppUpdateSnapshot | null,
  canInstall: boolean,
): string {
  if (snapshot?.phase === "checking") return intl.formatMessage({ id: "settings.about.checking" });
  if (snapshot?.phase === "downloading") {
    return intl.formatMessage(
      { id: "settings.about.downloading" },
      { progress: formatProgress(snapshot).label },
    );
  }
  if (snapshot?.phase === "installing")
    return intl.formatMessage({ id: "settings.about.installing" });
  if (snapshot?.installKind === "opened-installer") {
    return intl.formatMessage({ id: "settings.about.openInstaller" });
  }
  if (canInstall) return intl.formatMessage({ id: "settings.about.download" });
  return intl.formatMessage({ id: "settings.about.check" });
}

function formatProgress(snapshot: AppUpdateSnapshot | null): {
  percent: number | null;
  label: string;
} {
  const received = snapshot?.receivedBytes ?? 0;
  const total = snapshot?.totalBytes ?? 0;
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
  const label = percent !== null ? `${percent}%` : formatMegabytes(received);
  return { percent, label };
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayVersion(version: string | undefined): string {
  return version?.replace(/^v/i, "") ?? "";
}
