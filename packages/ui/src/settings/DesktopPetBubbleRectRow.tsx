import type { DesktopPetReaderBubbleRect, DesktopPetStageCrop } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "./SettingsPageParts.js";

/** 摸鱼气泡和角色舞台：只能在真实宠物窗口里拖拽调整，这里只放入口和当前尺寸。 */
export function DesktopPetBubbleRectRow(props: {
  rect: DesktopPetReaderBubbleRect | null;
  stageCrop: DesktopPetStageCrop | null;
  enabled: boolean;
  editing: boolean;
  onEdit: () => void;
  onReset: () => void;
}) {
  const { intl } = useZCodeIntl();
  // 尺寸放说明里而不是控件区：控件区窄，放个「气泡 306 × 108」会被挤断行。
  const current = [
    props.rect
      ? intl.formatMessage(
          { id: "settings.desktopPetBubbleRectValue" },
          { width: props.rect.w, height: props.rect.h },
        )
      : intl.formatMessage({ id: "settings.desktopPetBubbleRectAuto" }),
    props.stageCrop ? intl.formatMessage({ id: "settings.desktopPetBubbleRectCropped" }) : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.desktopPetBubbleRect" })}
      description={
        <>
          {intl.formatMessage({ id: "settings.desktopPetBubbleRectDescription" })}
          <div className="mt-1 text-xs text-muted-foreground">{current}</div>
        </>
      }
      control={
        <>
          {props.rect || props.stageCrop ? (
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
