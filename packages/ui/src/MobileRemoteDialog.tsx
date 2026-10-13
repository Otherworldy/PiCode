import { useEffect, useState } from "react";
import QRCode from "qrcode";
import type { MobileRemotePairingStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function MobileRemoteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const platform = usePlatform();
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<MobileRemotePairingStatus | "starting" | "failed">(
    "starting",
  );
  const [qrUrl, setQrUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus("starting");
    setQrUrl(null);
    void platform.startMobileRemotePairing?.().then(
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
  }, [open, platform]);

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
        {status !== "starting" && status !== "failed" && status.status === "unavailable" ? (
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "mobileRemote.noLan" })}
          </p>
        ) : null}
        {address ? (
          <div className="flex flex-col items-center gap-3">
            {qrUrl ? <img src={qrUrl} alt="" className="size-55 rounded-md bg-white p-2" /> : null}
            <p className="w-full break-all text-center text-ui-xs text-foreground-subtle">
              {address}
            </p>
            {status !== "starting" && status !== "failed" && status.firewall === "prompted" ? (
              <p className="text-center text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "mobileRemote.firewallPrompted" })}
              </p>
            ) : null}
            {status !== "starting" && status !== "failed" && status.firewall === "blocked" ? (
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
