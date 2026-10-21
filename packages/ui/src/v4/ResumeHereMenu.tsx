import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { FileTextIcon, GitBranchIcon, PencilIcon, TrendingUpDownIcon } from "lucide-react";
import { TID_V4_RESUME_MENU, testId } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export type ResumeHereChoice = {
  summarize: boolean;
  customInstructions?: string;
};

/**
 * 总结方式三选项。分叉菜单、回退菜单、编辑重发菜单共用同一份动作列表，
 * 避免三处各自维护文案与顺序（DESIGN：同一动作集复用同一动作列表内容）。
 */
export function ResumeHereChoiceItems({
  onPick,
  onCustom,
  disabled = false,
}: {
  onPick: (choice: ResumeHereChoice) => void;
  onCustom: () => void;
  /** 提交中保持行高与层级，只弱化文字色，不把菜单项抽掉。 */
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <DropdownMenuItem disabled={disabled} onSelect={() => onPick({ summarize: false })}>
        <GitBranchIcon />
        {intl.formatMessage({ id: "chat.tree.skipSummary" })}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => onPick({ summarize: true })}>
        <FileTextIcon />
        {intl.formatMessage({ id: "chat.tree.summarize" })}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={onCustom}>
        <PencilIcon />
        {intl.formatMessage({ id: "chat.tree.custom" })}
      </DropdownMenuItem>
    </>
  );
}

/** 回退 / 编辑重发共用：同一组动作、同一种浮层，锚点由调用方给。 */
export function SummaryChoiceMenu({
  open,
  onOpenChange,
  onPick,
  onCustom,
  trigger,
  disabled = false,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (choice: ResumeHereChoice) => void;
  onCustom: () => void;
  /** 必须是能承接 trigger props 的单个元素（按钮，或包住按钮并承接悬停提示的 span）。 */
  trigger: ReactNode;
  disabled?: boolean;
  onCloseAutoFocus?: ComponentProps<typeof DropdownMenuContent>["onCloseAutoFocus"];
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onCloseAutoFocus={onCloseAutoFocus}>
        <ResumeHereChoiceItems disabled={disabled} onPick={onPick} onCustom={onCustom} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 自定义总结要求仍是独立对话框：菜单只负责选动作，输入不挤进菜单里。 */
export function SummaryInstructionsDialog({
  open,
  onOpenChange,
  value,
  onChange,
  onConfirm,
  disabled = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "chat.tree.custom" })}</DialogTitle>
        </DialogHeader>
        <textarea
          className="h-24 w-full rounded-md border border-border bg-surface px-2 py-1 text-ui-sm"
          value={value}
          aria-label={intl.formatMessage({ id: "chat.tree.custom" })}
          placeholder={intl.formatMessage({ id: "chat.tree.customPlaceholder" })}
          onChange={(event) => onChange(event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="button" size="sm" disabled={disabled || !value.trim()} onClick={onConfirm}>
            {intl.formatMessage({ id: "chat.tree.confirm" })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function ResumeHereButton({
  onPick,
  onFork,
  rowId,
  toolbar = false,
}: {
  onPick: (choice: ResumeHereChoice) => void;
  onFork?: () => void;
  rowId: number;
  /** 放进行底工具条时一直可点，不靠整行悬停才显形。 */
  toolbar?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [menuOpen, setMenuOpen] = useState(false);
  const [customOpen, setCustomOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const marked = menuOpen || customOpen;
  const forkLabel = intl.formatMessage({ id: "chat.message.fork" });

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={forkLabel}
            title={forkLabel}
            data-testid={testId(TID_V4_RESUME_MENU, String(rowId))}
            data-resume-menu={marked ? "open" : "closed"}
            className={cn(
              "relative",
              toolbar
                ? undefined
                : marked
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0 group-hover/resume:pointer-events-auto group-hover/resume:opacity-100 group-hover/tool-summary:pointer-events-auto group-hover/tool-summary:opacity-100 group-focus-within/resume:pointer-events-auto group-focus-within/resume:opacity-100",
            )}
          >
            <TrendingUpDownIcon className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align={toolbar ? "end" : "start"} className="w-44">
          {onFork ? (
            <DropdownMenuItem onSelect={onFork}>
              <GitBranchIcon />
              {intl.formatMessage({ id: "chat.tree.forkHere" })}
            </DropdownMenuItem>
          ) : null}
          <ResumeHereChoiceItems
            onPick={onPick}
            onCustom={() => {
              setInstructions("");
              setCustomOpen(true);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <SummaryInstructionsDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        value={instructions}
        onChange={setInstructions}
        onConfirm={() => {
          onPick({ summarize: true, customInstructions: instructions.trim() });
          setCustomOpen(false);
        }}
      />
    </>
  );
}

function lastTextAnchor(root: HTMLElement): { left: number; top: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (node instanceof Text && node.textContent?.trim()) last = node;
  }
  if (!last?.textContent) return null;
  const range = document.createRange();
  range.setStart(last, last.textContent.length);
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  const parent = root.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0 && rect.top === 0) return null;
  const button = 28;
  let left = rect.right - parent.left + 4;
  let top = rect.top - parent.top;
  if (left + button > parent.width) {
    left = 0;
    top = rect.bottom - parent.top;
  }
  return { left, top };
}

/** 按钮跟在最后一个字后面，不固定在行的右缘。 */
export function ResumeHereAfterText({
  children,
  onPick,
  onFork,
  rowId,
}: {
  children: ReactNode;
  onPick: (choice: ResumeHereChoice) => void;
  onFork?: () => void;
  rowId: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const place = () => setAnchor(lastTextAnchor(root));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => observer.disconnect();
  }, [children]);
  return (
    <div ref={rootRef} className="group/resume relative w-full">
      {children}
      <span
        className="absolute z-10"
        style={anchor ? { left: anchor.left, top: anchor.top } : { visibility: "hidden" }}
      >
        <ResumeHereButton onPick={onPick} onFork={onFork} rowId={rowId} />
      </span>
    </div>
  );
}

export function ResumeHereMenu({
  children,
  onPick,
  onFork,
  rowId,
  align = "start",
}: {
  children: ReactNode;
  onPick: (choice: ResumeHereChoice) => void;
  onFork?: () => void;
  rowId: number;
  /** 用户气泡靠右，按钮贴在气泡左侧；其余行贴在正文右侧。 */
  align?: "start" | "end";
}) {
  return (
    <div
      className={cn(
        "group/resume relative w-fit max-w-full",
        align === "end" ? "self-end" : "self-start",
        "has-[[data-resume-menu=open]]:rounded-md has-[[data-resume-menu=open]]:bg-selected",
      )}
    >
      {children}
      <span
        className={cn(
          "absolute top-0.5 z-10",
          align === "end" ? "right-full mr-0.5" : "left-full ml-0.5",
        )}
      >
        <ResumeHereButton onPick={onPick} onFork={onFork} rowId={rowId} />
      </span>
    </div>
  );
}
