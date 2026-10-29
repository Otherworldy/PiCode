import { useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "./SettingsPageParts.js";

/** 摸鱼文本的选取与查找。查找只在当前文件里定位，不改正文内容。 */
export function DesktopPetReaderFileRows(props: {
  path: string;
  onPick: (path: string) => void;
  onClear: () => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [findDraft, setFindDraft] = useState("");
  const [findMiss, setFindMiss] = useState(false);
  const jumpToText = () => {
    const query = findDraft.trim();
    if (!query) return;
    void platform.findDesktopPetReaderText?.(query).then((found) => {
      setFindMiss(found === false);
    });
  };
  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReader" })}
        description={
          <>
            {intl.formatMessage({ id: "settings.desktopPetReaderDescription" })}
            {props.path ? <div className="mt-1 break-all">{props.path}</div> : null}
          </>
        }
        control={
          <>
            {props.path ? (
              <Button type="button" size="lg" variant="outline" onClick={props.onClear}>
                {intl.formatMessage({ id: "settings.desktopPetReaderClear" })}
              </Button>
            ) : null}
            <Button
              type="button"
              size="lg"
              variant="outline"
              onClick={() => {
                void (async () => {
                  const file = await platform.selectFile();
                  if (file) props.onPick(file);
                })();
              }}
            >
              {intl.formatMessage({ id: "settings.desktopPetReaderChoose" })}
            </Button>
          </>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReaderFind" })}
        description={
          findMiss
            ? intl.formatMessage({ id: "settings.desktopPetReaderFindMiss" })
            : intl.formatMessage({ id: "settings.desktopPetReaderFindDescription" })
        }
        detail={
          <Input
            size="lg"
            value={findDraft}
            aria-label={intl.formatMessage({ id: "settings.desktopPetReaderFind" })}
            onChange={(event) => {
              setFindDraft(event.target.value);
              setFindMiss(false);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              jumpToText();
            }}
            className="max-w-[520px]"
          />
        }
        control={
          <Button type="button" size="lg" variant="outline" onClick={jumpToText}>
            {intl.formatMessage({ id: "settings.desktopPetReaderFindAction" })}
          </Button>
        }
      />
    </>
  );
}
