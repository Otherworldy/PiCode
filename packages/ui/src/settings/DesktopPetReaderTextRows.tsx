import { useEffect, useState } from "react";
import {
  DESKTOP_PET_READER_FONT_SIZE_MAX,
  DESKTOP_PET_READER_FONT_SIZE_MIN,
  DESKTOP_PET_READER_LETTER_SPACING_MAX,
  DESKTOP_PET_READER_LETTER_SPACING_MIN,
  DESKTOP_PET_READER_LINE_HEIGHT_MAX,
  DESKTOP_PET_READER_LINE_HEIGHT_MIN,
  desktopPetReaderTextMetrics,
  normalizeDesktopPetReaderFontSize,
  normalizeDesktopPetReaderLetterSpacing,
  normalizeDesktopPetReaderLineHeight,
} from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "./SettingsPageParts.js";

/** 一个只收数字的输入框：输入过程中随便写，失焦或回车才归一化落盘。 */
function PetNumberInput(props: {
  value: number;
  label: string;
  suffix: string;
  decimals: boolean;
  enabled: boolean;
  normalize: (value: unknown) => number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => {
    setDraft(String(props.value));
  }, [props.value]);
  const commit = () => {
    const next = props.normalize(draft.trim() === "" ? undefined : draft);
    setDraft(String(next));
    if (next !== props.value) props.onCommit(next);
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        size="lg"
        inputMode="decimal"
        className="w-24"
        value={draft}
        disabled={!props.enabled}
        aria-label={props.label}
        onChange={(event) =>
          setDraft(
            props.decimals
              ? event.target.value.replace(/[^0-9.]/g, "")
              : event.target.value.replace(/[^0-9]/g, ""),
          )
        }
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          commit();
        }}
      />
      <span className="text-muted-foreground text-xs whitespace-nowrap">{props.suffix}</span>
    </div>
  );
}

/** 摸鱼正文的字号、行距、字间距。只作用正文，消息提醒气泡维持 12px。 */
export function DesktopPetReaderTextRows(props: {
  enabled: boolean;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  onFontSize: (value: number) => void;
  onLineHeight: (value: number) => void;
  onLetterSpacing: (value: number) => void;
}) {
  const { intl } = useZCodeIntl();
  // 行高是字号乘行距取整，直接把最后一次的换算结果给出来，省得用户自己算。
  const metrics = desktopPetReaderTextMetrics({
    readerFontSize: props.fontSize,
    readerLineHeight: props.lineHeight,
    readerLetterSpacing: props.letterSpacing,
  });
  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReaderFontSize" })}
        description={intl.formatMessage(
          { id: "settings.desktopPetReaderFontSizeDescription" },
          {
            min: DESKTOP_PET_READER_FONT_SIZE_MIN,
            max: DESKTOP_PET_READER_FONT_SIZE_MAX,
            line: metrics.lineHeight,
          },
        )}
        control={
          <PetNumberInput
            value={props.fontSize}
            label={intl.formatMessage({ id: "settings.desktopPetReaderFontSize" })}
            suffix="px"
            decimals={false}
            enabled={props.enabled}
            normalize={normalizeDesktopPetReaderFontSize}
            onCommit={props.onFontSize}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReaderLineHeight" })}
        description={intl.formatMessage(
          { id: "settings.desktopPetReaderLineHeightDescription" },
          {
            min: DESKTOP_PET_READER_LINE_HEIGHT_MIN,
            max: DESKTOP_PET_READER_LINE_HEIGHT_MAX,
          },
        )}
        control={
          <PetNumberInput
            value={props.lineHeight}
            label={intl.formatMessage({ id: "settings.desktopPetReaderLineHeight" })}
            suffix="×"
            decimals
            enabled={props.enabled}
            normalize={normalizeDesktopPetReaderLineHeight}
            onCommit={props.onLineHeight}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReaderLetterSpacing" })}
        description={intl.formatMessage(
          { id: "settings.desktopPetReaderLetterSpacingDescription" },
          {
            min: DESKTOP_PET_READER_LETTER_SPACING_MIN,
            max: DESKTOP_PET_READER_LETTER_SPACING_MAX,
          },
        )}
        control={
          <PetNumberInput
            value={props.letterSpacing}
            label={intl.formatMessage({ id: "settings.desktopPetReaderLetterSpacing" })}
            suffix="px"
            decimals
            enabled={props.enabled}
            normalize={normalizeDesktopPetReaderLetterSpacing}
            onCommit={props.onLetterSpacing}
          />
        }
      />
    </>
  );
}
