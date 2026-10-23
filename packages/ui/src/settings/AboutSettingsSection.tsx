/* eslint-disable max-lines -- 关于页各分区共享同一份版本/环境快照，拆文件会把状态外置成 props 传递。 */
import { useEffect, useState } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Download,
  ExternalLink,
  FileText,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { ZCODE_VERSION, type AppUpdateSnapshot } from "@zcode/shared";
import piLogoUrl from "@/assets/pi_logo.svg";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { StatusDot, type StatusDotTone } from "@/settings/StatusDot.js";

const GITHUB_REPO_URL = "https://github.com/Otherworldy/PiCode";
const LICENSE_URL = "https://github.com/Otherworldy/PiCode/blob/main/LICENSE";

export function AboutSettingsSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { getAppUpdateState, checkAppUpdate, onAppUpdateStateChanged, downloadAppUpdate } =
    platform;
  const canUpdate = typeof checkAppUpdate === "function";
  const [snapshot, setSnapshot] = useState<AppUpdateSnapshot | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!canUpdate || !getAppUpdateState || !checkAppUpdate) return;
    let cancelled = false;
    const apply = (next: AppUpdateSnapshot) => {
      if (!cancelled) setSnapshot(next);
    };
    const dispose = onAppUpdateStateChanged?.(apply);
    void (async () => {
      const current = await getAppUpdateState();
      if (cancelled) return;
      apply(current);
      // 重新进入本页时不要再检查：检查会作废正在进行的下载，进度就丢了。
      if (
        current.phase === "downloading" ||
        current.phase === "installing" ||
        current.phase === "downloaded"
      ) {
        return;
      }
      const checked = await checkAppUpdate();
      if (!cancelled) apply(checked);
    })();
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [canUpdate, getAppUpdateState, checkAppUpdate, onAppUpdateStateChanged]);

  const version = snapshot?.currentVersion || ZCODE_VERSION;
  const isChecking = snapshot?.phase === "checking";
  const isDownloading = snapshot?.phase === "downloading";
  const isInstalling = snapshot?.phase === "installing";
  const busy = isChecking || isDownloading || isInstalling;

  const hasNewVersion =
    snapshot?.phase === "available" ||
    snapshot?.phase === "downloaded" ||
    snapshot?.phase === "downloading" ||
    snapshot?.phase === "installing";

  const handleCopyVersion = async () => {
    try {
      await navigator.clipboard.writeText(version);
      setCopied(true);
      toast(intl.formatMessage({ id: "settings.about.versionCopied" }));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 忽略无法写入剪贴板的极端场景
    }
  };

  const handleOpenUrl = (url: string) => {
    if (platform.openExternal) {
      platform.openExternal(url);
    } else if (typeof window !== "undefined") {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const handleCheck = () => {
    if (!checkAppUpdate || busy) return;
    void checkAppUpdate().then((next) => setSnapshot(next));
  };

  const handleDownloadOrInstall = () => {
    if (!downloadAppUpdate || busy) return;
    void downloadAppUpdate().then((next) => setSnapshot(next));
  };

  return (
    <div className="space-y-6">
      {/* 顶部 Brand & Hero 卡片 */}
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-2xl border border-border/80 bg-surface p-2.5 shadow-xs">
            <img src={piLogoUrl} alt="PiCode" className="size-8 select-none" draggable={false} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-ui-xl font-bold tracking-tight text-foreground">PiCode</h2>
              <span className="rounded-md border border-border/60 bg-surface px-2 py-0.5 font-mono text-ui-xs font-medium text-foreground-subtle">
                v{version}
              </span>
              <UpdateStatusBadge snapshot={snapshot} canUpdate={canUpdate} />
            </div>
            <p className="mt-1 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.about.tagline" })}
            </p>
          </div>
        </div>

        {canUpdate ? (
          <div className="flex shrink-0 items-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={handleCheck}
              className="gap-1.5"
            >
              <RefreshCw className={cn("size-3.5", isChecking && "animate-spin")} />
              <span>
                {isChecking
                  ? intl.formatMessage({ id: "settings.about.checking" })
                  : intl.formatMessage({ id: "settings.about.check" })}
              </span>
            </Button>
          </div>
        ) : null}
      </div>

      {/* 新版本可用或更新中展示卡片 */}
      {hasNewVersion ? (
        <UpdateActionCard
          snapshot={snapshot}
          busy={busy}
          onDownloadOrInstall={handleDownloadOrInstall}
        />
      ) : null}

      {/* 检查出错时展示错误卡片 */}
      {snapshot?.phase === "error" && snapshot.errorCode ? (
        <UpdateErrorCard
          errorCode={snapshot.errorCode}
          canRetry={canUpdate && !busy}
          onRetry={handleCheck}
        />
      ) : null}

      {/* Release Notes 卡片 */}
      {snapshot?.notes ? (
        <ReleaseNotesCard notes={snapshot.notes} version={snapshot.latestVersion} />
      ) : null}

      {/* 基础详情与信息 */}
      <div className="space-y-2">
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
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void handleCopyVersion()}
                className="gap-1 text-foreground-subtle hover:text-foreground"
              >
                {copied ? (
                  <Check className="size-3.5 text-green-500" />
                ) : (
                  <Copy className="size-3.5" />
                )}
                <span>{intl.formatMessage({ id: "settings.about.copyVersion" })}</span>
              </Button>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.about.repository" })}
            description="Otherworldy/PiCode"
            control={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleOpenUrl(GITHUB_REPO_URL)}
                className="gap-1 text-foreground-subtle hover:text-foreground"
              >
                <span>{intl.formatMessage({ id: "settings.about.viewOnGithub" })}</span>
                <ExternalLink className="size-3.5" />
              </Button>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.about.license" })}
            description="Apache-2.0 License"
            control={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleOpenUrl(LICENSE_URL)}
                className="gap-1 text-foreground-subtle hover:text-foreground"
              >
                <ExternalLink className="size-3.5" />
              </Button>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.about.platform" })}
            description={getPlatformLabel()}
            control={<span />}
          />
        </SettingsGroupCard>
      </div>

      {/* 底部版权信息 */}
      <div className="pt-2 text-center text-ui-xs text-foreground-subtlest">
        <p>Copyright © {new Date().getFullYear()} PiCode. All rights reserved.</p>
      </div>
    </div>
  );
}

function UpdateStatusBadge({
  snapshot,
  canUpdate,
}: {
  snapshot: AppUpdateSnapshot | null;
  canUpdate: boolean;
}) {
  const { intl } = useZCodeIntl();

  if (!canUpdate) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface px-2.5 py-0.5 text-ui-xs text-foreground-subtle">
        <StatusDot tone="subtle" />
        <span>Web</span>
      </span>
    );
  }

  if (!snapshot || snapshot.phase === "idle") {
    return null;
  }

  if (snapshot.phase === "checking") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-surface px-2.5 py-0.5 text-ui-xs text-foreground-subtle">
        <StatusDot tone="subtle" spinning />
        <span>{intl.formatMessage({ id: "settings.about.checking" })}</span>
      </span>
    );
  }

  if (snapshot.phase === "upToDate") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-green-500/20 bg-green-500/10 px-2.5 py-0.5 text-ui-xs font-medium text-green-600 dark:text-green-400">
        <StatusDot tone="green" />
        <span>{intl.formatMessage({ id: "settings.about.upToDate" })}</span>
      </span>
    );
  }

  if (
    snapshot.phase === "available" ||
    snapshot.phase === "downloading" ||
    snapshot.phase === "downloaded" ||
    snapshot.phase === "installing"
  ) {
    const latest = displayVersion(snapshot.latestVersion);
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2.5 py-0.5 text-ui-xs font-medium text-amber-600 dark:text-amber-400">
        <StatusDot tone="amber" />
        <span>{intl.formatMessage({ id: "settings.about.available" }, { version: latest })}</span>
      </span>
    );
  }

  if (snapshot.phase === "error") {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-0.5 text-ui-xs font-medium text-red-600 dark:text-red-400">
        <StatusDot tone="red" />
        <span>{intl.formatMessage({ id: "settings.about.error.network" })}</span>
      </span>
    );
  }

  return null;
}

function UpdateActionCard({
  snapshot,
  busy,
  onDownloadOrInstall,
}: {
  snapshot: AppUpdateSnapshot;
  busy: boolean;
  onDownloadOrInstall: () => void;
}) {
  const { intl } = useZCodeIntl();
  const latest = displayVersion(snapshot.latestVersion);
  const progress = formatProgress(snapshot);

  const canInstall =
    snapshot.phase === "available" ||
    snapshot.phase === "downloaded" ||
    (snapshot.phase === "error" &&
      snapshot.errorCode !== "unpackaged" &&
      Boolean(snapshot.assetName));

  const hintMessage =
    snapshot.installKind === "opened-installer"
      ? intl.formatMessage({ id: "settings.about.openedHint" })
      : snapshot.installKind === "relaunch"
        ? intl.formatMessage({ id: "settings.about.relaunchHint" })
        : snapshot.installKind === "quit-for-installer"
          ? intl.formatMessage({ id: "settings.about.quitHint" })
          : null;

  return (
    <div className="rounded-xl border border-primary/25 bg-primary/5 p-4.5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-4.5" />
          </div>
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <h3 className="text-ui-base font-semibold text-foreground">
                {intl.formatMessage({ id: "settings.about.available" }, { version: latest })}
              </h3>
              <span className="rounded-full bg-primary/15 px-2 py-0.5 text-ui-xs font-semibold text-primary">
                New
              </span>
            </div>
            <p className="text-ui-sm text-foreground-subtle">
              {snapshot.assetName ? (
                <span>
                  {snapshot.assetName}
                  {snapshot.totalBytes ? ` (${formatMegabytes(snapshot.totalBytes)})` : ""}
                </span>
              ) : (
                intl.formatMessage({ id: "settings.about.readyToInstall" })
              )}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={busy && snapshot.phase !== "downloaded"}
            onClick={onDownloadOrInstall}
            className="gap-1.5 font-medium shadow-xs"
          >
            <Download className="size-3.5" />
            <span>{buttonLabel(intl, snapshot, canInstall)}</span>
          </Button>
        </div>
      </div>

      {/* 下载进度条 */}
      {snapshot.phase === "downloading" ? (
        <div className="mt-4 space-y-1.5">
          <div className="flex items-center justify-between text-ui-xs text-foreground-subtle">
            <span>{intl.formatMessage({ id: "settings.about.downloading" })}</span>
            <span className="font-mono">{progress.label}</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full border border-border/50 bg-surface">
            <div
              className="h-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${progress.percent ?? 0}%` }}
            />
          </div>
        </div>
      ) : null}

      {/* 安装说明提示 */}
      {hintMessage ? (
        <div className="mt-3 rounded-lg border border-border/60 bg-surface/50 px-3 py-2 text-ui-xs text-foreground-subtle">
          {hintMessage}
        </div>
      ) : null}
    </div>
  );
}

function UpdateErrorCard({
  errorCode,
  canRetry,
  onRetry,
}: {
  errorCode: string;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-destructive/25 bg-destructive/5 p-4 text-ui-base">
      <div className="flex items-center gap-2.5 text-destructive">
        <AlertCircle className="size-4 shrink-0" />
        <span className="text-ui-sm">
          {intl.formatMessage({ id: `settings.about.error.${errorCode}` })}
        </span>
      </div>
      {canRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry} className="shrink-0">
          {intl.formatMessage({ id: "settings.about.retry" })}
        </Button>
      ) : null}
    </div>
  );
}

function ReleaseNotesCard({ notes, version }: { notes: string; version?: string }) {
  const { intl } = useZCodeIntl();

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border bg-surface/40 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-foreground-subtle" />
          <span className="text-ui-base font-semibold text-foreground">
            {intl.formatMessage({ id: "settings.about.releaseNotes" })}
          </span>
        </div>
        {version ? (
          <span className="font-mono text-ui-xs text-foreground-subtle">
            v{displayVersion(version)}
          </span>
        ) : null}
      </div>
      <div className="max-h-64 overflow-y-auto p-4 pr-3">
        <ReleaseNotesContent notes={notes} />
      </div>
    </div>
  );
}

function ReleaseNotesContent({ notes }: { notes: string }) {
  const lines = notes.split(/\r?\n/);

  return (
    <div className="space-y-1.5 text-ui-base leading-relaxed text-foreground">
      {lines.map((rawLine, idx) => {
        const line = rawLine.trim();
        if (!line) {
          return <div key={idx} className="h-1.5" />;
        }
        if (line.startsWith("- ") || line.startsWith("* ")) {
          return (
            <div key={idx} className="flex items-start gap-2 text-ui-base text-foreground-subtle">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-foreground-subtle/80" />
              <span>{line.slice(2)}</span>
            </div>
          );
        }
        return (
          <p key={idx} className="text-ui-base text-foreground-subtle">
            {rawLine}
          </p>
        );
      })}
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
  const label =
    percent !== null
      ? `${percent}% (${formatMegabytes(received)} / ${formatMegabytes(total)})`
      : formatMegabytes(received);
  return { percent, label };
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayVersion(version: string | undefined): string {
  return version?.replace(/^v/i, "") ?? "";
}

function getPlatformLabel(): string {
  if (typeof navigator === "undefined") return "Desktop";
  const ua = navigator.userAgent;
  const isMac = /Macintosh|Mac OS X/i.test(ua);
  const isWindows = /Windows NT/i.test(ua);
  const isLinux = /Linux/i.test(ua);
  const os = isMac ? "macOS" : isWindows ? "Windows" : isLinux ? "Linux" : "Desktop";
  const isArm = /arm64|aarch64/i.test(ua);
  const arch = isArm ? "arm64" : "x64";
  return `${os} (${arch})`;
}
