import { memo, useMemo, useState } from "react";
import { GaugeIcon } from "lucide-react";
import {
  turnCacheHitRate,
  turnTotalTokens,
  turnTokensPerSecond,
  type TurnUsage,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 轮尾操作栏里的用量 pill。点击弹出明细。
 * 数字全部由 turn-usage 的纯函数派生，这里只做格式化和开合，不重算口径。
 */
export const ConversationTurnUsagePill = memo(function ConversationTurnUsagePill({
  usage,
}: {
  usage: TurnUsage;
}) {
  const { intl, locale } = useZCodeIntl();
  const [open, setOpen] = useState(false);

  const derived = useMemo(() => {
    const tokensPerSecond = turnTokensPerSecond(usage);
    return {
      total: turnTotalTokens(usage),
      cacheHitRate: turnCacheHitRate(usage),
      // 不足 1 tok/s 时不进列表：显示「0 tok/s」比不显示更让人困惑。
      tokensPerSecond:
        tokensPerSecond !== null && Math.round(tokensPerSecond) >= 1
          ? Math.round(tokensPerSecond)
          : null,
    };
  }, [usage]);

  // token 固定用 K/M，不跟 locale 走：中文的「万」跟在 tok 前面难读，
  // 而且和后面的 tok/s 单位混在一起容易看成两个数。
  const compact = (value: number, divisor: number, digits: number, unit: string) =>
    `${(value / divisor).toFixed(digits).replace(/\.?0+$/u, "")}${unit}`;
  const tokens = (value: number) =>
    value < 1_000
      ? `${value} tok`
      : value < 1_000_000
        ? `${compact(value, 1_000, 1, "K")} tok`
        : `${compact(value, 1_000_000, 2, "M")} tok`;
  const model =
    usage.providerId && usage.modelId
      ? `${usage.providerId}/${usage.modelId}`
      : (usage.modelId ?? usage.providerId);
  const totalLabel = tokens(derived.total);

  const rows: Array<{ key: string; label: string; value: string }> = [
    ...(model ? [{ key: "model", label: "chat.turnUsage.model", value: model }] : []),
    ...(derived.cacheHitRate === null
      ? []
      : [
          {
            key: "cache-hit",
            label: "chat.turnUsage.cacheHitRate",
            value: new Intl.NumberFormat(locale, {
              style: "percent",
              maximumFractionDigits: 1,
            }).format(derived.cacheHitRate),
          },
        ]),
    { key: "input", label: "chat.turnUsage.uncachedInput", value: tokens(usage.inputTokens) },
    { key: "cache-read", label: "chat.turnUsage.cacheRead", value: tokens(usage.cacheReadTokens) },
    // 缓存写入为 0 时省略：绝大多数会话都没有这一项，留着只是一行噪音。
    ...(usage.cacheWriteTokens === 0
      ? []
      : [
          {
            key: "cache-write",
            label: "chat.turnUsage.cacheWrite",
            value: tokens(usage.cacheWriteTokens),
          },
        ]),
    { key: "output", label: "chat.turnUsage.output", value: tokens(usage.outputTokens) },
    ...(derived.tokensPerSecond === null
      ? []
      : [
          {
            key: "tps",
            label: "chat.turnUsage.tokensPerSecond",
            value: intl.formatMessage(
              { id: "chat.turnUsage.tokensPerSecondValue" },
              { value: derived.tokensPerSecond },
            ),
          },
        ]),
  ];

  const title = intl.formatMessage({ id: "chat.turnUsage.title" });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "chat.turnUsage.pill" }, { total: totalLabel })}
          className="h-6 w-auto gap-1 rounded-md px-1.5 text-ui-sm font-normal text-foreground-subtle hover:text-foreground"
        >
          <GaugeIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="tabular-nums">
            {intl.formatMessage({ id: "chat.turnUsage.pill" }, { total: totalLabel })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        sideOffset={6}
        collisionPadding={16}
        sticky="always"
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-72 max-w-[calc(100vw-2rem)] gap-0 overflow-hidden border-popover-border p-0"
      >
        <div className="shrink-0 border-b border-border px-3 py-2">
          <h3 className="flex items-baseline justify-between gap-3 text-ui-base font-medium text-foreground">
            <span>{title}</span>
            <span className="tabular-nums text-foreground-muted">{totalLabel}</span>
          </h3>
        </div>
        <dl className="grid gap-1 px-3 py-2 text-ui-sm">
          {rows.map((row) => (
            <div key={row.key} className="flex items-baseline justify-between gap-3">
              <dt className="text-foreground-subtle">{intl.formatMessage({ id: row.label })}</dt>
              <dd className="tabular-nums text-foreground-muted">{row.value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
});
