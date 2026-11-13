import { LoaderIcon, RefreshCw } from "lucide-react";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function SessionReloadMenuItem({
  sessionId,
  readOnly,
  busy,
  pending,
  onReload,
}: {
  sessionId: string | null;
  readOnly: boolean;
  busy: boolean;
  pending: boolean;
  onReload?: (sessionId: string) => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  return (
    <DropdownMenuItem
      disabled={readOnly || !sessionId || !onReload || busy || pending}
      onSelect={() => {
        if (sessionId) void onReload?.(sessionId);
      }}
    >
      {pending ? <LoaderIcon className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
      {intl.formatMessage({ id: "appHeader.reloadSession" })}
    </DropdownMenuItem>
  );
}
