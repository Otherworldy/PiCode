import { memo, useMemo } from "react";
import { ActivityIcon, BotIcon, SquareTerminalIcon } from "lucide-react";
import { TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER } from "@zcode/shared";
import type { BackgroundWorkSummary } from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface ComposerBackgroundWorkCounts {
  bashCount: number;
  subagentCount: number;
  totalCount: number;
}

function getComposerBackgroundWorkCounts(
  backgroundWorks: readonly BackgroundWorkSummary[],
  runningSubagentCount = 0,
): ComposerBackgroundWorkCounts {
  let bashCount = 0;
  for (const work of backgroundWorks) {
    if (work.status !== "running") continue;
    if (work.kind === "bash") bashCount += 1;
  }
  const subagentCount = Math.max(0, runningSubagentCount);
  return {
    bashCount,
    subagentCount,
    totalCount: bashCount + subagentCount,
  };
}

interface ConversationBackgroundWorkTriggerProps {
  backgroundWorks: readonly BackgroundWorkSummary[];
  runningSubagentCount?: number;
  onOpen?: () => void;
}

function ConversationBackgroundWorkTriggerImpl({
  backgroundWorks,
  runningSubagentCount = 0,
  onOpen,
}: ConversationBackgroundWorkTriggerProps) {
  const { intl } = useZCodeIntl();
  const counts = useMemo(
    () => getComposerBackgroundWorkCounts(backgroundWorks, runningSubagentCount),
    [backgroundWorks, runningSubagentCount],
  );

  if (!onOpen || counts.totalCount === 0) return null;

  // 恰好一类时用该类文案，否则混合：两类两两组合各写一句会堆出同义 tooltip，
  // 而 badge 的作用只是「有实时活动，点开看」，不承担精确枚举。
  const activeKindCount = [counts.bashCount, counts.subagentCount].filter(
    (count) => count > 0,
  ).length;
  const tooltip = intl.formatMessage({
    id:
      activeKindCount > 1
        ? "chat.composer.backgroundWorks.tooltipMixed"
        : counts.bashCount > 0
          ? "chat.composer.backgroundWorks.tooltipTerminal"
          : "chat.composer.backgroundWorks.tooltipAgent",
  });
  const ariaLabel = intl.formatMessage(
    { id: "chat.composer.backgroundWorks.ariaLabel" },
    {
      bashCount: String(counts.bashCount),
      subagentCount: String(counts.subagentCount),
      count: String(counts.totalCount),
    },
  );

  return (
    <ControlHintTooltip title={tooltip}>
      <Button
        type="button"
        variant="ghost"
        size="default"
        data-testid={TID_V4_COMPOSER_BACKGROUND_WORK_TRIGGER}
        data-background-bash-count={counts.bashCount}
        data-background-subagent-count={counts.subagentCount}
        data-background-total-count={counts.totalCount}
        aria-label={ariaLabel}
        onClick={onOpen}
        className="rounded-lg px-1.5 text-ui-base text-[var(--color-foreground-subtle)] tabular-nums"
      >
        <span
          data-composer-background-layout="typed"
          className="inline-flex items-center gap-1 @max-[480px]/composer:hidden"
          aria-hidden
        >
          {counts.bashCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <SquareTerminalIcon className="size-3.5" />
              <span>{counts.bashCount}</span>
            </span>
          ) : null}
          {counts.subagentCount > 0 ? (
            <span className="inline-flex items-center gap-0.5">
              <BotIcon className="size-3.5" />
              <span>{counts.subagentCount}</span>
            </span>
          ) : null}
        </span>
        <span
          data-composer-background-layout="compact"
          className="hidden items-center gap-0.5 @max-[480px]/composer:inline-flex"
          aria-hidden
        >
          <ActivityIcon className="size-3.5" />
          <span>{counts.totalCount}</span>
        </span>
      </Button>
    </ControlHintTooltip>
  );
}

export const ConversationBackgroundWorkTrigger = memo(ConversationBackgroundWorkTriggerImpl);
