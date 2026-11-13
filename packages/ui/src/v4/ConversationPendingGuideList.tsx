import { memo, useMemo } from "react";
import type { QueueItem, UserInputRow } from "@picode/shared/picode-protocol-v4";
import { XIcon } from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationTurnRow } from "@/v4/ConversationTurnRow.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

interface ConversationPendingGuideListProps {
  context: ConversationRowRenderContext;
  items: readonly QueueItem[];
  turnId: string;
  /**
   * 取消单条待生效 GUIDE（deleteQueueItem command）。
   * 只读视图不传；不隐藏条目，等权威 queue 投影移除。
   */
  onCancel?: (queueItemId: string) => void;
}

function pendingGuideRow(item: QueueItem, turnId: string): UserInputRow & { entityId: string } {
  return {
    rowId: -(item.order.admissionSeq + 1),
    turnId,
    productTurnId: turnId,
    entityId: item.queueItemId,
    kind: "userInput",
    text: item.text,
    origin: "realUser",
    sourceCommandId: item.sourceCommandId,
    clientId: item.clientId,
    attachments: item.attachments,
    createdAt: item.admittedAt,
    createdAtSeq: item.order.admissionSeq,
  };
}

function ConversationPendingGuideListImpl({
  context,
  items,
  turnId,
  onCancel,
}: ConversationPendingGuideListProps) {
  const { intl } = useZCodeIntl();
  const rows = useMemo(
    () => items.map((item) => ({ item, row: pendingGuideRow(item, turnId) })),
    [items, turnId],
  );
  const status = intl.formatMessage({ id: "chat.message.turnSteer.pending" });
  const cancelSettlementStatus = intl.formatMessage({
    id: "chat.queue.cancelSettlementPending",
  });
  const cancelLabel = intl.formatMessage({ id: "chat.queue.cancelGuide" });
  const retryCancelLabel = intl.formatMessage({ id: "chat.queue.retryCancelGuide" });

  if (rows.length === 0) return null;
  return (
    <div data-v4-pending-guide-list="true" className="flex flex-col gap-5 pt-5">
      {rows.map(({ item, row }) => {
        const cancelSettlementPending = Boolean(item.cancelSettlementPending);
        const canCancel =
          item.dispatch.state === "reserved" &&
          (cancelSettlementPending || item.steer.state === "steering");
        return (
          <div
            key={row.sourceCommandId}
            data-v4-pending-guide-item={row.entityId}
            className="flex flex-col gap-1"
          >
            <ConversationTurnRow
              row={row}
              context={context}
              userInputStatus={cancelSettlementPending ? cancelSettlementStatus : status}
            />
            {onCancel && canCancel ? (
              <div className="flex justify-end">
                <ControlHintTooltip
                  title={cancelSettlementPending ? retryCancelLabel : cancelLabel}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-v4-pending-guide-cancel={row.entityId}
                    aria-label={cancelSettlementPending ? retryCancelLabel : cancelLabel}
                    className="text-foreground-subtle hover:text-foreground"
                    onClick={() => onCancel(row.entityId)}
                  >
                    <XIcon data-icon="inline-start" />
                    {cancelSettlementPending ? retryCancelLabel : cancelLabel}
                  </Button>
                </ControlHintTooltip>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export const ConversationPendingGuideList = memo(ConversationPendingGuideListImpl);
