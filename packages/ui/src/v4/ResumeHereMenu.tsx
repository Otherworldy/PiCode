import { cloneElement, isValidElement, useState, type ReactElement, type ReactNode } from "react";
import { FileTextIcon, GitBranchIcon, PencilIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type ResumeHereChoice = {
  summarize: boolean;
  customInstructions?: string;
};

function MenuItem({
  trigger,
  onSelect,
  children,
}: {
  trigger: "context" | "click";
  onSelect: () => void;
  children: ReactNode;
}) {
  return trigger === "click" ? (
    <DropdownMenuItem onSelect={onSelect}>{children}</DropdownMenuItem>
  ) : (
    <ContextMenuItem onSelect={onSelect}>{children}</ContextMenuItem>
  );
}

export function ResumeHereMenu({
  children,
  onPick,
  trigger = "context",
}: {
  children: ReactNode;
  onPick: (choice: ResumeHereChoice) => void;
  /** context：右键。click：编辑重发旁的按钮。 */
  trigger?: "context" | "click";
}) {
  const { intl } = useZCodeIntl();
  const [menuOpen, setMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const marked = menuOpen || customOpen;
  const triggerNode = isValidElement(children)
    ? cloneElement(children as ReactElement<{ className?: string }>, {
        className: cn(
          (children as ReactElement<{ className?: string }>).props.className,
          marked && "rounded-md bg-selected",
        ),
      })
    : children;
  const items = (
    <>
      <MenuItem trigger={trigger} onSelect={() => onPick({ summarize: false })}>
        <GitBranchIcon />
        {intl.formatMessage({ id: "chat.tree.skipSummary" })}
      </MenuItem>
      <MenuItem trigger={trigger} onSelect={() => onPick({ summarize: true })}>
        <FileTextIcon />
        {intl.formatMessage({ id: "chat.tree.summarize" })}
      </MenuItem>
      <MenuItem
        trigger={trigger}
        onSelect={() => {
          setInstructions("");
          setCustomOpen(true);
        }}
      >
        <PencilIcon />
        {intl.formatMessage({ id: "chat.tree.custom" })}
      </MenuItem>
    </>
  );

  return (
    <>
      {trigger === "click" ? (
        <DropdownMenu onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>{triggerNode}</DropdownMenuTrigger>
          <DropdownMenuContent className="w-44">{items}</DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <ContextMenu onOpenChange={setMenuOpen}>
          <ContextMenuTrigger asChild>{triggerNode}</ContextMenuTrigger>
          <ContextMenuContent className="w-44">{items}</ContextMenuContent>
        </ContextMenu>
      )}
      <Dialog open={customOpen} onOpenChange={setCustomOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{intl.formatMessage({ id: "chat.tree.custom" })}</DialogTitle>
          </DialogHeader>
          <textarea
            className="h-24 w-full rounded-md border border-border bg-surface px-2 py-1 text-ui-sm"
            value={instructions}
            placeholder={intl.formatMessage({ id: "chat.tree.customPlaceholder" })}
            onChange={(event) => setInstructions(event.target.value)}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!instructions.trim()}
              onClick={() => {
                onPick({ summarize: true, customInstructions: instructions.trim() });
                setCustomOpen(false);
              }}
            >
              <FileTextIcon className="size-3.5" />
              {intl.formatMessage({ id: "chat.tree.confirm" })}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
