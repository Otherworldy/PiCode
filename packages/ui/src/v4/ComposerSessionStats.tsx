import { memo, useMemo, useState } from "react";
import { DatabaseIcon, GaugeIcon } from "lucide-react";
import {
  turnCacheHitRate,
  turnTotalTokens,
  type SessionUsageState,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 会话统计的派生值。弹窗内容走 Portal，静态渲染里拿不到，所以口径单拎出来可测。
 * 与 dsh 一致：TTFT 是平均值（总时长 / 有首 token 的步数），速度只算解码段。
 */
export function deriveSessionStats(cumulative: SessionUsageState["cumulative"]) {
  const rate = turnCacheHitRate(cumulative);
  const decodeSpeed =
    cumulative.decodeMs > 0 ? cumulative.decodeTokens / (cumulative.decodeMs / 1_000) : null;
  return {
    total: turnTotalTokens(cumulative),
    cacheHit: rate === null ? null : Math.round(rate * 100),
    // 不足 1 tok/s 不进列表：显示「0 tok/s」比不显示更让人困惑。
    speed: decodeSpeed !== null && decodeSpeed >= 1 ? decodeSpeed : null,
    ttftAverage: cumulative.ttftSteps > 0 ? cumulative.ttftMs / cumulative.ttftSteps : null,
  };
}

/**
 * 输入框下方的会话统计。数字全部来自快照的 usage.cumulative，这里只做格式化和开合，
 * 不在客户端重算口径。冷恢复的重开会话与实时走同一条累加路径，不需要额外加载。
 *
 * 形态对齐 dsh 的 composer dock：两个 pill，有明细的才可点；没有耗时数据时
 * 会话 pill 退回纯文本，而不是弹出一个空面板。
 */
export const ComposerSessionStats = memo(function ComposerSessionStats({
  cumulative,
}: {
  cumulative: SessionUsageState["cumulative"];
}) {
  const { intl, locale } = useZCodeIntl();
  const [openPill, setOpenPill] = useState<"activity" | "usage" | null>(null);

  const derived = useMemo(() => deriveSessionStats(cumulative), [cumulative]);

  // token 固定用 K/M，不跟 locale 走：中文的「万」跟在 tok 前面难读，
  // 而且与单位混在一起容易看成两个数。与轮尾用量 pill 保持一致。
  const compact = (value: number, divisor: number, digits: number, unit: string) =>
    `${(value / divisor).toFixed(digits).replace(/\.?0+$/u, "")}${unit}`;
  const tokens = (value: number) =>
    value < 1_000
      ? `${value} tok`
      : value < 1_000_000
        ? `${compact(value, 1_000, 1, "K")} tok`
        : `${compact(value, 1_000_000, 2, "M")} tok`;
  const exact = (value: number) => new Intl.NumberFormat(locale).format(value);
  // token 数必须带单位：弹窗里只有一串数字时，1000 和 1000 的含义全靠猜。
  const exactTokens = (value: number) => `${exact(value)} tok`;
  const duration = (ms: number) => {
    const seconds = ms / 1_000;
    if (seconds < 60) {
      return intl.formatMessage(
        { id: "chat.sessionStats.durationSeconds" },
        { seconds: seconds.toFixed(1) },
      );
    }
    return intl.formatMessage(
      { id: "chat.sessionStats.durationMinutes" },
      { minutes: String(Math.floor(seconds / 60)), seconds: String(Math.round(seconds % 60)) },
    );
  };
  const speedText = (value: number) =>
    intl.formatMessage(
      { id: "chat.turnUsage.tokensPerSecondValue" },
      { value: value >= 10 ? String(Math.round(value)) : value.toFixed(1) },
    );

  // 空会话不画任何统计：一行 0 轮 0 步对用户没有信息量。
  if (derived.total <= 0 && cumulative.turns <= 0) return null;

  const pillClass =
    "inline-flex min-w-0 shrink items-center gap-1.5 whitespace-nowrap rounded-full px-2 h-6 text-ui-caption font-normal text-foreground-subtle tabular-nums";
  // nowrap：数值与单位是一个整体，断开成「206」/「tok/s」两行比截断更难看。
  const rowLabel = "whitespace-nowrap text-foreground-subtle";
  const rowValue = "whitespace-nowrap text-right tabular-nums text-foreground";

  const counts = intl.formatMessage(
    { id: "chat.sessionStats.counts" },
    { turns: String(cumulative.turns), steps: String(cumulative.steps) },
  );
  const countsLabel =
    derived.speed === null ? (
      counts
    ) : (
      <>
        {counts}
        <span aria-hidden="true" className="mx-1.5 opacity-60">
          ·
        </span>
        {speedText(derived.speed)}
      </>
    );

  const timingRows: Array<{ key: string; label: string; value: string }> = [
    ...(cumulative.llmMs > 0
      ? [{ key: "llm", label: "chat.sessionStats.llmTime", value: duration(cumulative.llmMs) }]
      : []),
    ...(cumulative.toolMs > 0
      ? [{ key: "tool", label: "chat.sessionStats.toolTime", value: duration(cumulative.toolMs) }]
      : []),
    ...(derived.ttftAverage === null
      ? []
      : [
          {
            key: "ttft",
            label: "chat.sessionStats.ttft",
            value: duration(derived.ttftAverage),
          },
        ]),
    ...(derived.speed === null
      ? []
      : [{ key: "speed", label: "chat.sessionStats.speed", value: speedText(derived.speed) }]),
  ];

  const activityIcon = <GaugeIcon className="size-3.5 shrink-0" />;

  return (
    <div
      className="flex min-w-0 flex-nowrap items-center justify-center gap-1 overflow-hidden"
      data-testid="composer-session-stats"
    >
      {timingRows.length === 0 ? (
        // 没有一条耗时可用时不做成按钮，避免点开一个空面板。
        <span className={pillClass} data-testid="composer-session-activity">
          {activityIcon}
          <span className="min-w-0 truncate">{countsLabel}</span>
        </span>
      ) : (
        <Popover
          open={openPill === "activity"}
          onOpenChange={(next) => setOpenPill(next ? "activity" : null)}
        >
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className={pillClass}>
              {activityIcon}
              <span className="min-w-0 truncate">{countsLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent
            align="center"
            side="top"
            className="w-72 max-w-[calc(100vw-24px)] gap-0 p-3"
          >
            <div className="mb-2 text-ui-caption font-medium text-foreground">
              {intl.formatMessage({ id: "chat.sessionStats.title" })}
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui-caption">
              {timingRows.map((row) => (
                <div key={row.key} className="contents">
                  <dt className={rowLabel}>{intl.formatMessage({ id: row.label })}</dt>
                  <dd className={rowValue}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </PopoverContent>
        </Popover>
      )}

      <Popover
        open={openPill === "usage"}
        onOpenChange={(next) => setOpenPill(next ? "usage" : null)}
      >
        <PopoverTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className={pillClass}>
            <DatabaseIcon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">
              {tokens(derived.total)}
              {derived.cacheHit === null ? null : (
                <>
                  <span aria-hidden="true" className="mx-1.5 opacity-60">
                    ·
                  </span>
                  {intl.formatMessage(
                    { id: "chat.sessionStats.cacheHit" },
                    { percent: String(derived.cacheHit) },
                  )}
                </>
              )}
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent align="center" side="top" className="w-72 max-w-[calc(100vw-24px)] gap-0 p-3">
          <div className="mb-2 flex items-baseline justify-between gap-3 text-ui-caption font-medium text-foreground">
            <span className="whitespace-nowrap">
              {intl.formatMessage({ id: "chat.sessionStats.usageTitle" })}
            </span>
            <span className="whitespace-nowrap tabular-nums text-foreground-subtle">
              {exactTokens(derived.total)}
            </span>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-ui-caption">
            {derived.cacheHit === null ? null : (
              <>
                <dt className={rowLabel}>
                  {intl.formatMessage({ id: "chat.turnUsage.cacheHitRate" })}
                </dt>
                <dd className={rowValue}>{derived.cacheHit}%</dd>
              </>
            )}
            <dt className={rowLabel}>{intl.formatMessage({ id: "chat.turnUsage.uncachedInput" })}</dt>
            <dd className={rowValue}>{exactTokens(cumulative.inputTokens)}</dd>
            <dt className={rowLabel}>{intl.formatMessage({ id: "chat.turnUsage.cacheRead" })}</dt>
            <dd className={rowValue}>{exactTokens(cumulative.cacheReadTokens)}</dd>
            {cumulative.cacheWriteTokens === 0 ? null : (
              <>
                <dt className={rowLabel}>
                  {intl.formatMessage({ id: "chat.turnUsage.cacheWrite" })}
                </dt>
                <dd className={rowValue}>{exactTokens(cumulative.cacheWriteTokens)}</dd>
              </>
            )}
            <dt className={rowLabel}>{intl.formatMessage({ id: "chat.turnUsage.output" })}</dt>
            <dd className={rowValue}>{exactTokens(cumulative.outputTokens)}</dd>
          </dl>
        </PopoverContent>
      </Popover>
    </div>
  );
});
