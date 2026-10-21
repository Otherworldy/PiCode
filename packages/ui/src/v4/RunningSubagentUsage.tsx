import { ChevronDownIcon, GaugeIcon } from "lucide-react";
import { useMemo } from "react";
import {
  turnCacheHitRate,
  turnTokensPerSecond,
  turnTotalTokens,
  type TurnUsage,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 子智能体卡片上的用量展示：pills + 构成条 + 卡内明细。
 *
 * 数字口径全部来自 `turn-usage` 的派生函数，这里只做格式化与排版——
 * 和轮尾的 `ConversationTurnUsagePill` 用同一套算法，不另算一份。
 */

/**
 * token 固定用 K/M 并去掉尾零，不跟 locale 走：中文的「万」跟在 tok 前面难读，
 * 和后面的 tok/s 混在一起也容易看成两个数。规则与轮尾用量 pill 一致。
 */
function formatSubagentTokens(value: number): { num: string; unit: string } {
  const tokens = Number.isFinite(value) && value > 0 ? value : 0;
  const trim = (text: string) => text.replace(/\.?0+$/u, "");
  if (tokens < 1_000) return { num: String(Math.round(tokens)), unit: "tok" };
  if (tokens < 1_000_000) return { num: `${trim((tokens / 1_000).toFixed(1))}K`, unit: "tok" };
  return { num: `${trim((tokens / 1_000_000).toFixed(2))}M`, unit: "tok" };
}

function subagentTokensLabel(value: number): string {
  const { num, unit } = formatSubagentTokens(value);
  return `${num} ${unit}`;
}

/** 不足 1 tok/s 时不显示：写 0 比不写更让人困惑。 */
export function subagentTokensPerSecond(usage: TurnUsage): number | null {
  const value = turnTokensPerSecond(usage);
  return value !== null && Math.round(value) >= 1 ? Math.round(value) : null;
}

export function RunningSubagentUsagePill({
  expanded,
  onToggle,
  usage,
}: {
  expanded: boolean;
  onToggle: () => void;
  usage: TurnUsage;
}) {
  const { intl } = useZCodeIntl();
  const total = turnTotalTokens(usage);
  // 全零用量不画 pill：数据侧本就会丢掉全零的 message_end，这里只防其它入口。
  if (total <= 0) return null;
  const { num, unit } = formatSubagentTokens(total);

  return (
    <button
      type="button"
      data-running-subagent-usage-trigger="true"
      aria-expanded={expanded}
      aria-label={intl.formatMessage({ id: "chat.turnUsage.pill" }, { total: `${num} ${unit}` })}
      onClick={(event) => {
        // 这一行底下还有「打开子会话」的覆盖层按钮，点用量不能顺带打开详情。
        event.stopPropagation();
        onToggle();
      }}
      className="pointer-events-auto relative z-[2] inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-[var(--color-border)] bg-transparent px-1.5 text-ui-xs tabular-nums text-[var(--color-foreground)] hover:border-[var(--color-border-hover)] hover:bg-[var(--color-hover)]"
    >
      <GaugeIcon aria-hidden className="size-3 shrink-0 text-[var(--color-foreground-subtle)]" />
      <span>{num}</span>
      <span className="text-[var(--color-foreground-subtle)]">{unit}</span>
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "size-3 shrink-0 text-[var(--color-foreground-subtle)] transition-transform",
          expanded && "rotate-180",
        )}
      />
    </button>
  );
}

export function RunningSubagentUsageBreakdown({
  expanded,
  usage,
}: {
  expanded: boolean;
  usage: TurnUsage;
}) {
  const { intl, locale } = useZCodeIntl();

  const derived = useMemo(() => {
    const total = turnTotalTokens(usage);
    const cacheTokens = usage.cacheReadTokens + usage.cacheWriteTokens;
    const hitRate = turnCacheHitRate(usage);
    const tokensPerSecond = subagentTokensPerSecond(usage);
    const share = (value: number) => (total > 0 ? `${((value / total) * 100).toFixed(2)}%` : "0%");
    return {
      total,
      cacheTokens,
      hitRateLabel:
        hitRate === null
          ? "—"
          : new Intl.NumberFormat(locale, {
              style: "percent",
              maximumFractionDigits: 1,
            }).format(hitRate),
      tokensPerSecondLabel:
        tokensPerSecond === null
          ? "—"
          : intl.formatMessage(
              { id: "chat.turnUsage.tokensPerSecondValue" },
              { value: tokensPerSecond },
            ),
      cacheShare: share(cacheTokens),
      inputShare: share(usage.inputTokens),
      outputShare: share(usage.outputTokens),
    };
  }, [intl, locale, usage]);

  if (derived.total <= 0) return null;

  const cells = [
    {
      key: "hit",
      label: intl.formatMessage({ id: "chat.turnUsage.cacheHitRate" }),
      value: derived.hitRateLabel,
    },
    {
      key: "input",
      label: intl.formatMessage({ id: "chat.turnUsage.uncachedInput" }),
      value: subagentTokensLabel(usage.inputTokens),
    },
    {
      key: "cache",
      // 标签写「缓存」而不是「缓存读取」：cacheWrite 也并进这一段，
      // 与下面构成条的第一段同一个口径。
      label: intl.formatMessage({ id: "chat.statusPanel.subagentUsage.cache" }),
      value: subagentTokensLabel(derived.cacheTokens),
    },
    {
      key: "output",
      label: intl.formatMessage({ id: "chat.turnUsage.output" }),
      value: subagentTokensLabel(usage.outputTokens),
    },
    {
      key: "tps",
      label: intl.formatMessage({ id: "chat.turnUsage.tokensPerSecond" }),
      value: derived.tokensPerSecondLabel,
    },
    {
      key: "total",
      label: intl.formatMessage({ id: "chat.statusPanel.subagentUsage.total" }),
      value: subagentTokensLabel(derived.total),
    },
  ];

  const legend = [
    {
      key: "cache",
      dot: "bg-[var(--color-usage-chart-1)]",
      label: intl.formatMessage({ id: "chat.statusPanel.subagentUsage.cache" }),
      value: subagentTokensLabel(derived.cacheTokens),
    },
    {
      key: "input",
      dot: "bg-[var(--color-usage-chart-2)]",
      label: intl.formatMessage({ id: "chat.statusPanel.subagentUsage.uncached" }),
      value: subagentTokensLabel(usage.inputTokens),
    },
    {
      key: "output",
      dot: "bg-[var(--color-usage-chart-3)]",
      label: intl.formatMessage({ id: "chat.statusPanel.subagentUsage.output" }),
      value: subagentTokensLabel(usage.outputTokens),
    },
  ];

  return (
    <div className="relative z-[1] flex min-w-0 flex-col">
      <div
        role="img"
        aria-label={intl.formatMessage(
          { id: "chat.statusPanel.subagentUsage.rail" },
          {
            cache: subagentTokensLabel(derived.cacheTokens),
            input: subagentTokensLabel(usage.inputTokens),
            output: subagentTokensLabel(usage.outputTokens),
          },
        )}
        className="flex h-[3px] min-w-0 gap-[2px] overflow-hidden rounded-full bg-[var(--color-border)]"
      >
        {usage.cacheReadTokens + usage.cacheWriteTokens > 0 ? (
          <span
            aria-hidden
            className="block h-full rounded-full bg-[var(--color-usage-chart-1)]"
            style={{ width: derived.cacheShare }}
          />
        ) : null}
        {usage.inputTokens > 0 ? (
          <span
            aria-hidden
            className="block h-full rounded-full bg-[var(--color-usage-chart-2)]"
            style={{ width: derived.inputShare }}
          />
        ) : null}
        {usage.outputTokens > 0 ? (
          <span
            aria-hidden
            className="block h-full rounded-full bg-[var(--color-usage-chart-3)]"
            style={{ width: derived.outputShare }}
          />
        ) : null}
      </div>

      <div
        aria-hidden={!expanded}
        className="grid transition-[grid-template-rows] duration-200 ease-out"
        style={{ gridTemplateRows: expanded ? "1fr" : "0fr" }}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="pointer-events-auto mt-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-2">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              {cells.map((cell) => (
                <div key={cell.key} className="flex min-w-0 flex-col">
                  <dt className="truncate text-ui-xs text-[var(--color-foreground-subtle)]">
                    {cell.label}
                  </dt>
                  <dd className="truncate text-ui-sm tabular-nums text-[var(--color-foreground)]">
                    {cell.value}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs text-[var(--color-foreground-subtle)]">
              {legend.map((item) => (
                <span key={item.key} className="inline-flex min-w-0 items-center gap-1">
                  <span aria-hidden className={cn("size-1 shrink-0 rounded-full", item.dot)} />
                  <span className="truncate">
                    {item.label} {item.value}
                  </span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
