import type { DesktopPetInstalledPack } from "@zcode/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function DesktopPetDeleteDialog({
  pack,
  onClose,
  onConfirm,
}: {
  pack: DesktopPetInstalledPack | null;
  onClose: () => void;
  onConfirm: (pack: DesktopPetInstalledPack) => void;
}) {
  const { intl } = useZCodeIntl();
  if (!pack) return null;

  const isLocal = pack.sourceType === "local";

  return (
    <AlertDialog open={Boolean(pack)} onOpenChange={(open) => (!open ? onClose() : null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {intl.formatMessage({
              id: isLocal
                ? "settings.desktopPetDeleteConfirmTitleLocal"
                : "settings.desktopPetDeleteConfirmTitleDownload",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription className="space-y-2 text-foreground-subtle">
            <div>
              {intl.formatMessage(
                {
                  id: isLocal
                    ? "settings.desktopPetDeleteConfirmDescLocal"
                    : "settings.desktopPetDeleteConfirmDescDownload",
                },
                { name: pack.name },
              )}
            </div>
            <div className="font-mono text-xs break-all rounded bg-surface p-2 text-foreground">
              {isLocal ? pack.localPath : pack.url}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>
            {intl.formatMessage({ id: "common.cancel" })}
          </AlertDialogCancel>
          <AlertDialogAction
            className={
              !isLocal
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
            onClick={() => {
              onConfirm(pack);
              onClose();
            }}
          >
            {intl.formatMessage({
              id: isLocal
                ? "settings.desktopPetDeleteConfirmActionLocal"
                : "settings.desktopPetDeleteConfirmActionDownload",
            })}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
