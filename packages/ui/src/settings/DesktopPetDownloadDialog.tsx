import { useState } from "react";
import { DESKTOP_PET_RECOMMENDED_PACK_URL, type DesktopPetDownloadStatus } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DesktopPetDownloadStatusLine } from "./DesktopPetDownloadStatusLine.js";

export function DesktopPetDownloadDialog({
  open,
  onOpenChange,
  status,
  onStart,
  onStop,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: DesktopPetDownloadStatus;
  onStart: (url: string) => void;
  onStop: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [urlDraft, setUrlDraft] = useState(DESKTOP_PET_RECOMMENDED_PACK_URL);

  const busy = status.phase === "downloading" || status.phase === "extracting";

  return (
    <Dialog open={open} onOpenChange={(next) => (!busy ? onOpenChange(next) : null)}>
      <DialogContent className="max-w-[540px]">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.desktopPetDownloadDialogTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.desktopPetDownloadDialogDesc" })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1.5">
            <Input
              size="lg"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              placeholder="https://"
              disabled={busy}
              className="font-mono text-xs"
            />
            <div className="flex items-center justify-between gap-2 text-xs text-foreground-subtle">
              <span className="truncate max-w-[360px]">
                {intl.formatMessage({ id: "settings.desktopPetRecommended" })}
                {DESKTOP_PET_RECOMMENDED_PACK_URL}
              </span>
              <button
                type="button"
                className="text-primary hover:underline shrink-0 font-medium"
                onClick={() => setUrlDraft(DESKTOP_PET_RECOMMENDED_PACK_URL)}
                disabled={busy}
              >
                {intl.formatMessage({ id: "settings.desktopPetUseRecommended" })}
              </button>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface-subtle p-3 min-h-[48px] flex flex-col justify-center">
            <DesktopPetDownloadStatusLine status={status} />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          {busy ? (
            <Button type="button" variant="destructive" onClick={onStop}>
              {intl.formatMessage({ id: "settings.desktopPetDownloadStop" })}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!urlDraft.trim()}
              onClick={() => onStart(urlDraft.trim())}
            >
              {intl.formatMessage({ id: "settings.desktopPetDownloadDialogStart" })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
