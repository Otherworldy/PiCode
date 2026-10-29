import { useCallback, useState } from "react";
import {
  TID_V4_USER_INPUT_DIALOG,
  TID_V4_USER_INPUT_OPTION,
  TID_V4_USER_INPUT_TEXT,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { XIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { V4UserInputViewModel } from "@/v4/pendingInteractionAdapter.js";

interface V4UserInputDialogProps {
  model: V4UserInputViewModel;
  onSubmit: (answer: { optionId?: string; freeText?: string }) => void;
  onDismiss?: () => void;
  /** 放进已有弹窗时去掉自己的卡片边框。 */
  flush?: boolean;
}

/** v4 userInput 交互最小弹窗（竖切）。 */
export function V4UserInputDialog({
  model,
  onSubmit,
  onDismiss,
  flush = false,
}: V4UserInputDialogProps) {
  const { intl } = useZCodeIntl();
  const [freeText, setFreeText] = useState("");

  const handleOption = useCallback(
    (optionId: string) => {
      onSubmit({ optionId });
    },
    [onSubmit],
  );

  const handleFreeTextSubmit = useCallback(() => {
    const trimmed = freeText.trim();
    if (!trimmed && model.freeText) return;
    onSubmit(model.freeText ? { freeText: trimmed } : { optionId: model.options[0]?.optionId });
  }, [freeText, model.freeText, model.options, onSubmit]);

  return (
    <div className="w-full shrink-0 relative z-1" data-testid={TID_V4_USER_INPUT_DIALOG}>
      <div
        className={
          flush
            ? "p-5"
            : "w-full overflow-hidden rounded-2xl border border-border bg-popover p-3 shadow-xs"
        }
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <p className="min-w-0 flex-1 text-ui-base text-[var(--color-foreground)]">{model.prompt}</p>
          {flush && onDismiss ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="shrink-0 rounded-xl"
              aria-label={intl.formatMessage({ id: "common.close" })}
              onClick={onDismiss}
            >
              <XIcon className="size-4" />
            </Button>
          ) : null}
        </div>
        {model.options.length > 0 ? (
          <div className="mb-3 flex flex-col gap-2">
            {model.options.map((option) => (
              <Button
                key={option.optionId}
                type="button"
                variant="outline"
                size={flush ? "lg" : "default"}
                className={flush ? "h-9 px-4" : undefined}
                data-testid={testId(TID_V4_USER_INPUT_OPTION, option.optionId)}
                onClick={() => handleOption(option.optionId)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        ) : null}
        {model.freeText ? (
          <div className="flex flex-col gap-2">
            <Input
              size={flush ? "lg" : "default"}
              type={model.sensitive ? "password" : "text"}
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              data-testid={TID_V4_USER_INPUT_TEXT}
            />
            <div className="flex justify-end gap-2">
              {onDismiss ? (
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  className="h-9 px-4"
                  onClick={onDismiss}
                >
                  {intl.formatMessage({ id: "chat.elicitation.dismiss" })}
                </Button>
              ) : null}
              <Button type="button" size="lg" className="h-9 px-4" onClick={handleFreeTextSubmit}>
                提交
              </Button>
            </div>
          </div>
        ) : null}
        {model.freeText ? null : onDismiss ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="h-9 px-4"
              onClick={onDismiss}
            >
              {intl.formatMessage({ id: "chat.elicitation.dismiss" })}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
