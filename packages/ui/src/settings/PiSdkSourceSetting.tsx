import { useEffect, useState } from "react";
import type { ZCodePiSdkStatus } from "@zcode/shared";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

type PiSdkSource = "builtin" | "global";

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
            : "";

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.piSdkSource" })}
      description={[
        intl.formatMessage({ id: "settings.piSdkSource.description" }),
        detail,
      ]
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
            <SelectItem value="builtin">
              {intl.formatMessage({ id: "settings.piSdkSource.builtin" })}
            </SelectItem>
            <SelectItem value="global">
              {intl.formatMessage({ id: "settings.piSdkSource.global" })}
            </SelectItem>
          </SelectContent>
        </Select>
      }
    />
  );
}
