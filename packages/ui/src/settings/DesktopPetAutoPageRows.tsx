import { useEffect, useState } from "react";
import { normalizeDesktopPetAutoPageMs } from "@zcode/shared";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "./SettingsPageParts.js";

/** 自动翻页只在按住模式有意义：点击切换没有松手这个动作，窗口本来就不关。 */
export function DesktopPetAutoPageRows({
  hold,
  enabled,
  autoPage,
  autoPageMs,
  onAutoPage,
  onAutoPageMs,
}: {
  hold: boolean;
  enabled: boolean;
  autoPage: boolean;
  autoPageMs: number;
  onAutoPage: (checked: boolean) => void;
  onAutoPageMs: (ms: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(String(autoPageMs));
  useEffect(() => {
    setDraft(String(autoPageMs));
  }, [autoPageMs]);
  if (!hold) return null;
  const commit = () => {
    const next = normalizeDesktopPetAutoPageMs(draft.trim() === "" ? undefined : draft);
    setDraft(String(next));
    if (next !== autoPageMs) onAutoPageMs(next);
  };
  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReaderAutoPage" })}
        description={intl.formatMessage({ id: "settings.desktopPetReaderAutoPageDescription" })}
        control={
          <Switch
            checked={autoPage}
            disabled={!enabled}
            aria-label={intl.formatMessage({ id: "settings.desktopPetReaderAutoPage" })}
            onCheckedChange={onAutoPage}
          />
        }
      />
      {autoPage ? (
        <SettingsRow
          label={intl.formatMessage({ id: "settings.desktopPetReaderAutoPageMs" })}
          description={intl.formatMessage({
            id: "settings.desktopPetReaderAutoPageMsDescription",
          })}
          control={
            <Input
              size="lg"
              inputMode="numeric"
              className="w-32"
              value={draft}
              disabled={!enabled}
              aria-label={intl.formatMessage({ id: "settings.desktopPetReaderAutoPageMs" })}
              onChange={(event) => setDraft(event.target.value.replace(/[^0-9]/g, ""))}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                commit();
              }}
            />
          }
        />
      ) : null}
    </>
  );
}
