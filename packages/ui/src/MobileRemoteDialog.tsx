import { useEffect, useState } from "react";
import QRCode from "qrcode";
import {
  MOBILE_REMOTE_DEFAULT_PORT,
  parseMobileRemotePort,
  type MobileRemotePairingStatus,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function MobileRemoteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const platform = usePlatform();
  const { settings, loading, update } = useSettings();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<MobileRemotePairingStatus | "starting" | "failed">(
    "starting",
  );
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [portText, setPortText] = useState(String(MOBILE_REMOTE_DEFAULT_PORT));
  const [portInvalid, setPortInvalid] = useState(false);
  const [applying, setApplying] = useState(false);
  const savedPort = settings?.mobileRemotePort ?? MOBILE_REMOTE_DEFAULT_PORT;

  useEffect(() => {
    if (!open || loading) return;
    let cancelled = false;
    setPortText(String(savedPort));
    setPortInvalid(false);
    setStatus("starting");
    setQrUrl(null);
    void platform.startMobileRemotePairing?.(savedPort).then(
      (next) => {
        if (!cancelled) setStatus(next ?? { status: "unavailable", reason: "no-lan-address" });
      },
      () => {
        if (!cancelled) setStatus("failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, loading, platform, savedPort]);

  async function applyPort() {
    const port = parseMobileRemotePort(portText);
    if (port == null) {
      setPortInvalid(true);
      return;
    }
    setPortInvalid(false);
    setApplying(true);
    try {
      if (port !== savedPort) {
        await update({ mobileRemotePort: port });
        return;
      }
      setStatus("starting");
      const next = await platform.startMobileRemotePairing?.(port);
      setStatus(next ?? { status: "unavailable", reason: "no-lan-address" });
    } catch {
      setStatus("failed");
    } finally {
      setApplying(false);
    }
  }

  const address =
    status !== "starting" && status !== "failed" && status.status === "ready" ? status.url : null;

  useEffect(() => {
    if (!address) {
      setQrUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(address, { margin: 1, width: 220 }).then(
      (value) => {
        if (!cancelled) setQrUrl(value);
      },
      () => {
        if (!cancelled) setQrUrl(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [address]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "mobileRemote.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "mobileRemote.description" })}
          </DialogDescription>
        </DialogHeader>
        {status === "starting" ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "mobileRemote.starting" })}
          </p>
        ) : null}
        {status === "failed" ? (
          <p className="text-ui-sm text-destructive">
            {intl.formatMessage({ id: "mobileRemote.failed" })}
          </p>
        ) : null}
        {status !== "starting" && status !== "failed" && status.status === "unavailable" && status.reason === "no-lan-address" ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "mobileRemote.noLan" })}
          </p>
        ) : null}
        <div className="flex items-center gap-2">
          <label className="shrink-0 text-ui-sm text-foreground" htmlFor="mobile-remote-port">
            {intl.formatMessage({ id: "mobileRemote.port" })}
          </label>
          <Input
            id="mobile-remote-port"
            inputMode="numeric"
            value={portText}
            onChange={(event) => {
              setPortText(event.target.value);
              setPortInvalid(false);
            }}
          />
          <Button
            type="button"
            variant="outline"
            disabled={applying || loading}
            onClick={() => {
              void applyPort();
            }}
          >
            {intl.formatMessage({ id: "mobileRemote.portApply" })}
          </Button>
        </div>
        {portInvalid ? (
          <p className="text-ui-xs text-destructive">
            {intl.formatMessage({ id: "mobileRemote.portInvalid" })}
          </p>
        ) : null}
        {status !== "starting" && status !== "failed" && status.status === "unavailable" && status.reason === "port-in-use" ? (
          <p className="text-ui-xs text-destructive">
            {intl.formatMessage({ id: "mobileRemote.portInUse" })}
          </p>
        ) : null}
        {address ? (
          <div className="flex flex-col items-center gap-3">
            {qrUrl ? <img src={qrUrl} alt="" className="size-55 rounded-md bg-white p-2" /> : null}
            <p className="w-full break-all text-center text-ui-xs text-foreground-subtle">
              {address}
            </p>
            {status !== "starting" && status !== "failed" && status.status === "ready" && status.firewall === "prompted" ? (
              <p className="text-center text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "mobileRemote.firewallPrompted" })}
              </p>
            ) : null}
            {status !== "starting" && status !== "failed" && status.status === "ready" && status.firewall === "blocked" ? (
              <p className="text-center text-ui-xs text-destructive">
                {intl.formatMessage({ id: "mobileRemote.firewallBlocked" })}
              </p>
            ) : null}
          </div>
        ) : null}
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void platform.stopMobileRemotePairing?.().finally(() => onOpenChange(false));
          }}
        >
          {intl.formatMessage({ id: "mobileRemote.disconnect" })}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
