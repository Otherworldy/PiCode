import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, GitBranchIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { sessionBranchTips } from "@/v4/sessionBranchTips.js";
import { useSessionBranchActions } from "@/v4/sessionBranchStore.js";

export function SessionBranchPill({ sessionId }: { sessionId?: string | null }) {
  const { intl } = useZCodeIntl();
  const actions = useSessionBranchActions(sessionId);
  const [open, setOpen] = useState(false);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const tips = useMemo(() => sessionBranchTips(actions?.nodes ?? []), [actions?.nodes]);
  const current = tips.find((tip) => tip.current) ?? tips[0];
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? tips.filter((tip) => `${tip.label ?? ""} ${tip.preview} ${tip.forkPreview ?? ""}`.toLowerCase().includes(needle))
    : tips;

  if (!actions || !current) return null;

  const nameOf = (tip: (typeof tips)[number]) =>
    tip.label ?? tip.forkPreview ?? intl.formatMessage({ id: "chat.branch.main" });

  return (
    <DropdownMenu
      modal={false}
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        setRenamingId(null);
        setArmedId(null);
        if (next) actions.refresh();
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 max-w-44 shrink-0 gap-1 rounded-full px-2 text-ui-sm [app-region:no-drag]"
          aria-label={intl.formatMessage({ id: "chat.branch.switch" })}
        >
          <GitBranchIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate">{nameOf(current)}</span>
          {tips.length > 1 ? (
            <span className="rounded-full bg-surface px-1.5 text-ui-xs text-foreground-subtle">{tips.length}</span>
          ) : null}
          <ChevronDownIcon className="size-3 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2">
          <div className="mb-1.5 text-ui-xs font-medium text-foreground-subtle">
            {intl.formatMessage({ id: "chat.branch.switch" })}
          </div>
          <input
            className="h-7 w-full rounded-md border border-border bg-surface px-2 text-ui-sm"
            value={query}
            placeholder={intl.formatMessage({ id: "chat.branch.filter" })}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
          />
        </div>
        <div className="max-h-60 overflow-y-auto p-1">
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "chat.branch.empty" })}
            </p>
          ) : (
            visible.map((tip) => {
              const name = nameOf(tip);
              const detail = tip.preview && tip.preview !== name ? tip.preview : "";
              return (
                <div
                  key={tip.id}
                  className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${tip.current ? "bg-accent" : "hover:bg-surface-hover"}`}
                >
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    disabled={actions.busy || tip.current}
                    onClick={() => {
                      actions.switchTo(tip.id);
                      setOpen(false);
                    }}
                  >
                    {tip.current ? <CheckIcon className="size-3.5 shrink-0" /> : <GitBranchIcon className="size-3.5 shrink-0 text-foreground-subtle" />}
                    <span className="min-w-0">
                      <span className="flex items-center gap-1">
                        <span className="truncate text-ui-sm">{name}</span>
                        {tip.current ? (
                          <span className="shrink-0 rounded bg-brand px-1 text-ui-xs text-foreground-inverse">
                            {intl.formatMessage({ id: "chat.branch.current" })}
                          </span>
                        ) : null}
                      </span>
                      {detail ? <span className="block truncate text-ui-xs text-foreground-subtle">{detail}</span> : null}
                    </span>
                  </button>
                  {renamingId === tip.id ? (
                    <input
                      className="h-7 w-28 rounded-md border border-border bg-surface px-1.5 text-ui-sm"
                      value={draft}
                      autoFocus
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === "Enter") {
                          actions.rename(tip.id, draft);
                          setRenamingId(null);
                        }
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <span className="flex shrink-0">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={intl.formatMessage({ id: "chat.branch.rename" })}
                        onClick={() => {
                          setRenamingId(tip.id);
                          setDraft(tip.label ?? name);
                        }}
                      >
                        <PencilIcon className="size-3.5" />
                      </Button>
                      {!tip.current && tips.length > 1 ? (
                        <Button
                          type="button"
                          variant={armedId === tip.id ? "destructive" : "ghost"}
                          size={armedId === tip.id ? "sm" : "icon-sm"}
                          aria-label={intl.formatMessage({ id: "chat.branch.delete" })}
                          onClick={() => {
                            if (armedId !== tip.id) {
                              setArmedId(tip.id);
                              return;
                            }
                            actions.remove(tip.id);
                            setOpen(false);
                          }}
                        >
                          <Trash2Icon className="size-3.5" />
                          {armedId === tip.id ? intl.formatMessage({ id: "chat.branch.delete" }) : null}
                        </Button>
                      ) : null}
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
        <p className="border-t border-border px-3 py-2 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.branch.hint" })}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
