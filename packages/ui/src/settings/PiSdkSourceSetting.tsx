import { useEffect, useState } from "react";
import type { ZCodePiSdkStatus } from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

export type PiSdkSource = "builtin" | "global";

/**
 * 计算 Pi SDK 在设置页的展示内容（版本徽章、提示文案、下拉选项文本）。
 * 依据：此前默认使用内置 SDK 时完全不展示版本号，且下拉选项未标注版本，
 * 导致用户无法在设置页确认当前实际运行的 Pi SDK 版本。
 */
export function resolvePiSdkVersionPresentation(options: {
  status: ZCodePiSdkStatus | undefined;
  source: PiSdkSource;
  intl: IntlInstance;
}) {
  const { status, source, intl } = options;
  // 当前进程生效的 SDK 版本：全局激活时取 globalVersion（回退到 builtinVersion），否则取 builtinVersion
  const activeVersion =
    status?.active === "global"
      ? (status.globalVersion ?? status.builtinVersion)
      : status?.builtinVersion;

  const pendingRestart = Boolean(status && status.requested !== source);
  const detail = pendingRestart
    ? intl.formatMessage({ id: "settings.piSdkSource.pending" })
    : status?.reason === "missing"
      ? intl.formatMessage({ id: "settings.piSdkSource.missing" })
      : status?.reason === "incompatible"
        ? intl.formatMessage(
            { id: "settings.piSdkSource.incompatible" },
            {
              globalVersion: status.globalVersion ?? "",
              builtinVersion: status.builtinVersion,
            },
          )
        : status?.reason === "load-failed"
          ? intl.formatMessage({ id: "settings.piSdkSource.loadFailed" })
          : status?.active === "global"
            ? intl.formatMessage(
                { id: "settings.piSdkSource.usingGlobal" },
                { version: status.globalVersion ?? "" },
              )
            : status?.active === "builtin" && status?.builtinVersion
              ? intl.formatMessage(
                  { id: "settings.piSdkSource.usingBuiltin" },
                  { version: status.builtinVersion },
                )
              : "";

  const builtinLabel = status?.builtinVersion
    ? `${intl.formatMessage({ id: "settings.piSdkSource.builtin" })} (v${status.builtinVersion})`
    : intl.formatMessage({ id: "settings.piSdkSource.builtin" });

  const globalLabel = status?.globalVersion
    ? `${intl.formatMessage({ id: "settings.piSdkSource.global" })} (v${status.globalVersion})`
    : intl.formatMessage({ id: "settings.piSdkSource.global" });

  return {
    activeVersion,
    detail,
    builtinLabel,
    globalLabel,
  };
}

export function PiSdkSourceSetting() {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const [source, setSource] = useState<PiSdkSource>("builtin");
  const [status, setStatus] = useState<ZCodePiSdkStatus | undefined>();

  useEffect(() => {
    if (!services) return;
    let cancelled = false;
    void services.settingService
      .get()
      .then((settings) => {
        if (!cancelled) setSource(settings.piSdkSource === "global" ? "global" : "builtin");
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [services]);

  useEffect(() => {
    if (!services) return;
    let cancelled = false;
    void services.zcodeAgentService
      .readPiSdkStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [services, source]);

  const { activeVersion, detail, builtinLabel, globalLabel } = resolvePiSdkVersionPresentation({
    status,
    source,
    intl,
  });

  return (
    <SettingsRow
      label={
        <div className="flex items-center gap-2">
          <span>{intl.formatMessage({ id: "settings.piSdkSource" })}</span>
          {activeVersion ? (
            <Badge
              variant="secondary"
              className="font-mono text-ui-xs"
              data-testid="pi-sdk-version-badge"
            >
              v{activeVersion}
            </Badge>
          ) : null}
        </div>
      }
      description={[intl.formatMessage({ id: "settings.piSdkSource.description" }), detail]
        .filter(Boolean)
        .join(" ")}
      control={
        <Select
          value={source}
          onValueChange={(value) => {
            const next: PiSdkSource = value === "global" ? "global" : "builtin";
            setSource(next);
            if (!services) return;
            void services.settingService.update({ piSdkSource: next }).catch(() => {
              setSource(source);
            });
          }}
        >
          <SelectTrigger
            size="lg"
            className="w-[260px] min-w-0 justify-between"
            aria-label={intl.formatMessage({ id: "settings.piSdkSource" })}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="builtin">{builtinLabel}</SelectItem>
            <SelectItem value="global">{globalLabel}</SelectItem>
          </SelectContent>
        </Select>
      }
    />
  );
}
