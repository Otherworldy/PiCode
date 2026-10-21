import type { DesktopPetReaderBubbleRect } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "./SettingsPageParts.js";

/** 摸鱼气泡的大小和位置：只能在真实宠物窗口里拖拽调整，这里只放入口和当前尺寸。 */
export function DesktopPetBubbleRectRow(props: {
  rect: DesktopPetReaderBubbleRect | null;
  enabled: boolean;
  editing: boolean;
  onEdit: () => void;
  onReset: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.desktopPetBubbleRect" })}
      description={intl.formatMessage({ id: "settings.desktopPetBubbleRectDescription" })}
      control={
        <>
          <span className="text-xs text-muted-foreground">
            {props.rect
              ? intl.formatMessage(
                  { id: "settings.desktopPetBubbleRectValue" },
                  { width: props.rect.w, height: props.rect.h },
                )
              : intl.formatMessage({ id: "settings.desktopPetBubbleRectAuto" })}
          </span>
          {props.rect ? (
            <Button type="button" size="lg" variant="outline" onClick={props.onReset}>
              {intl.formatMessage({ id: "settings.desktopPetBubbleRectReset" })}
            </Button>
          ) : null}
          <Button
            type="button"
            size="lg"
            variant="outline"
            disabled={props.editing || !props.enabled}
            onClick={props.onEdit}
          >
            {intl.formatMessage({
              id: props.editing
                ? "settings.desktopPetBubbleRectEditing"
                : "settings.desktopPetBubbleRectEdit",
            })}
          </Button>
        </>
      }
    />
  );
}
