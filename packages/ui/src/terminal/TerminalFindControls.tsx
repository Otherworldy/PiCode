import { CaseSensitive, ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { SearchAddon } from "@xterm/addon-search";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  formatTerminalFindCount,
  terminalSearchOptions,
  type TerminalFindResult,
} from "@/terminal/terminalFind.js";

export function TerminalFindControls({
  open,
  result,
  addonRef,
  inputRef,
  onOpen,
  onClose,
  onResult,
}: {
  open: boolean;
  result: TerminalFindResult | null;
  addonRef: RefObject<SearchAddon | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  onOpen: () => void;
  onClose: () => void;
  onResult: (result: TerminalFindResult | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const queryRef = useRef(query);
  const caseSensitiveRef = useRef(caseSensitive);
  queryRef.current = query;
  caseSensitiveRef.current = caseSensitive;

  const runSearch = (
    direction: "next" | "previous",
    incremental: boolean,
    nextQuery = queryRef.current,
    nextCaseSensitive = caseSensitiveRef.current,
  ) => {
    const addon = addonRef.current;
    if (!addon) return;
    if (nextQuery.length === 0) {
      addon.clearDecorations();
      onResult(null);
      return;
    }
    const options = terminalSearchOptions(nextCaseSensitive, incremental && direction === "next");
    try {
      const found =
        direction === "previous"
          ? addon.findPrevious(nextQuery, options)
          : addon.findNext(nextQuery, options);
      if (!found) onResult({ resultIndex: -1, resultCount: 0 });
    } catch (error) {
      // 查找失败只影响查找条。抛到 effect 里会被终端错误边界吃掉，表现为整块终端空白。
      logger.warn("[Terminal] search failed:", error);
      onResult({ resultIndex: -1, resultCount: 0 });
    }
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    runSearch("next", false);
    // 只在查找条从关闭变为打开时重跑当前查询；输入过程由 onChange 增量搜索。
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runSearch 读取打开瞬间的 query ref
  }, [open]);

  if (!open) {
    return (
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="absolute top-1 right-5 z-20 bg-background/80 opacity-0 group-hover/terminal:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        title={intl.formatMessage({ id: "terminal.find" })}
        aria-label={intl.formatMessage({ id: "terminal.find" })}
        onClick={onOpen}
      >
        <Search />
      </Button>
    );
  }

  const count = formatTerminalFindCount(query, result);
  const countText =
    count.kind === "match"
      ? intl.formatMessage(
          { id: "terminal.find.count" },
          { current: count.current, total: count.total },
        )
      : count.kind === "overflow"
        ? `${count.total}+`
        : count.kind === "none"
          ? intl.formatMessage({ id: "terminal.find.noMatches" })
          : "";

  return (
    <div
      className="absolute top-1 right-5 z-20 flex max-w-[calc(100%-2.5rem)] items-center gap-0.5 rounded-md border border-border bg-background/95 px-1 py-0.5 shadow-sm"
      data-terminal-find-bar
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <Input
        ref={inputRef}
        size="sm"
        value={query}
        placeholder={intl.formatMessage({ id: "terminal.find.placeholder" })}
        aria-label={intl.formatMessage({ id: "terminal.find.placeholder" })}
        className="w-36"
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          const nextQuery = event.target.value;
          setQuery(nextQuery);
          runSearch("next", true, nextQuery);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
          event.preventDefault();
          runSearch(event.shiftKey ? "previous" : "next", false);
        }}
      />
      <span className="shrink-0 px-1 text-center text-ui-base whitespace-nowrap text-foreground-subtle tabular-nums">
        {countText}
      </span>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title={intl.formatMessage({ id: "terminal.find.previous" })}
        aria-label={intl.formatMessage({ id: "terminal.find.previous" })}
        onClick={() => runSearch("previous", false)}
      >
        <ChevronUp />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title={intl.formatMessage({ id: "terminal.find.next" })}
        aria-label={intl.formatMessage({ id: "terminal.find.next" })}
        onClick={() => runSearch("next", false)}
      >
        <ChevronDown />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-pressed={caseSensitive}
        className="aria-pressed:bg-hover"
        title={intl.formatMessage({ id: "terminal.find.caseSensitive" })}
        aria-label={intl.formatMessage({ id: "terminal.find.caseSensitive" })}
        onClick={() => {
          const nextCaseSensitive = !caseSensitive;
          setCaseSensitive(nextCaseSensitive);
          runSearch("next", false, query, nextCaseSensitive);
        }}
      >
        <CaseSensitive />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        title={intl.formatMessage({ id: "terminal.find.close" })}
        aria-label={intl.formatMessage({ id: "terminal.find.close" })}
        onClick={onClose}
      >
        <X />
      </Button>
    </div>
  );
}
