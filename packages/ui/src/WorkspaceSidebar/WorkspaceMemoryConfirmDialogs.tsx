import { TID_WORKSPACE_MEMORY_DELETE_CONFIRM } from "@zcode/shared";
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

export function WorkspaceMemoryDiscardDialog({
  open,
  onOpenChange,
  onDiscard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDiscard: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog onOpenChange={onOpenChange} open={open}>
      {open ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.memory.viewer.discardTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage({ id: "settings.memory.viewer.discardDescription" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {intl.formatMessage({ id: "settings.memory.viewer.keepEditing" })}
            </AlertDialogCancel>
            <AlertDialogAction onClick={onDiscard}>
              {intl.formatMessage({ id: "settings.memory.viewer.discard" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}

export function WorkspaceMemoryDeleteDialog({
  fileName,
  onCancel,
  onConfirm,
}: {
  fileName: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
      open={fileName !== null}
    >
      {fileName ? (
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {intl.formatMessage({ id: "settings.memory.viewer.deleteTitle" })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {intl.formatMessage(
                { id: "settings.memory.viewer.deleteDescription" },
                { name: fileName },
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {intl.formatMessage({ id: "settings.memory.viewer.cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              data-testid={TID_WORKSPACE_MEMORY_DELETE_CONFIRM}
              onClick={onConfirm}
            >
              {intl.formatMessage({ id: "settings.memory.viewer.deleteConfirm" })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      ) : null}
    </AlertDialog>
  );
}
