import { normalizeDesktopPetDisplayScale } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "./SettingsPageParts.js";

const PET_DISPLAY_SCALE_OPTIONS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.5];

/** 气泡底色和角色显示大小：两个纯外观选项，和开关放在同一张卡片里。 */
export function DesktopPetBubbleStyleRows(props: {
  tone: "dark" | "light";
  displayScale: number;
  onTone: (tone: "dark" | "light") => void;
  onDisplayScale: (scale: number) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetBubble" })}
        description={intl.formatMessage({ id: "settings.desktopPetBubbleDescription" })}
        control={
          <Select
            value={props.tone}
            onValueChange={(value) => props.onTone(value === "light" ? "light" : "dark")}
          >
            <SelectTrigger
              size="lg"
              className="w-48"
              aria-label={intl.formatMessage({ id: "settings.desktopPetBubble" })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="dark">
                {intl.formatMessage({ id: "settings.desktopPetBubble.dark" })}
              </SelectItem>
              <SelectItem value="light">
                {intl.formatMessage({ id: "settings.desktopPetBubble.light" })}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />

      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetDisplayScale" })}
        description={intl.formatMessage({ id: "settings.desktopPetDisplayScaleDescription" })}
        control={
          <Select
            value={String(props.displayScale)}
            onValueChange={(value) =>
              props.onDisplayScale(normalizeDesktopPetDisplayScale(Number(value)))
            }
          >
            <SelectTrigger
              size="lg"
              className="w-48"
              aria-label={intl.formatMessage({ id: "settings.desktopPetDisplayScale" })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PET_DISPLAY_SCALE_OPTIONS.map((value) => (
                <SelectItem key={value} value={String(value)}>
                  {intl.formatMessage(
                    { id: "settings.desktopPetDisplayScaleValue" },
                    { percent: Math.round(value * 100) },
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
    </>
  );
}
