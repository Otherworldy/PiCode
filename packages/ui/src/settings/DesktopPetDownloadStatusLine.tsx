import type { DesktopPetDownloadStatus } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DesktopPetDownloadStatusLine({ status }: { status: DesktopPetDownloadStatus }) {
  const { intl } = useZCodeIntl();
  if (status.phase === "idle") return null;
  const text =
    status.phase === "downloading"
      ? intl.formatMessage(
          { id: "settings.desktopPetDownloading" },
          { progress: formatPetDownloadProgress(status.received, status.total) },
        )
      : status.phase === "extracting"
        ? intl.formatMessage({ id: "settings.desktopPetExtracting" })
        : status.phase === "ready"
          ? intl.formatMessage({ id: "settings.desktopPetDownloadReady" })
          : status.phase === "stopped"
            ? intl.formatMessage({ id: "settings.desktopPetDownloadStopped" })
            : status.reason === "http"
              ? intl.formatMessage(
                  { id: "settings.desktopPetDownloadFailed.http" },
                  { status: status.status ?? "" },
                )
              : status.reason === "invalid-url"
                ? intl.formatMessage({ id: "settings.desktopPetDownloadFailed.invalid-url" })
                : status.reason === "too-large"
                  ? intl.formatMessage({ id: "settings.desktopPetDownloadFailed.too-large" })
                  : status.reason === "missing-config"
                    ? intl.formatMessage({
                        id: "settings.desktopPetDownloadFailed.missing-config",
                      })
                    : intl.formatMessage({ id: "settings.desktopPetDownloadFailed.network" });
  return <div className="mt-1">{text}</div>;
}

function formatPetDownloadProgress(received: number, total: number | null): string {
  if (total && total > 0) return `${Math.min(100, Math.floor((received / total) * 100))}%`;
  if (received < 1024 * 1024) return `${Math.ceil(received / 1024)} KB`;
  return `${(received / (1024 * 1024)).toFixed(1)} MB`;
}
