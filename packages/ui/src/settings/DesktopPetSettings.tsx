import { useEffect, useRef, useState } from "react";
import {
  normalizeDesktopPetReaderHotkey,
  normalizeDesktopPetReaderHotkeyMode,
  type AppSettings,
  type DesktopPetDownloadStatus,
  type DesktopPetInstalledPack,
  type DesktopPetPersistedSettings,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DesktopPetDownloadDialog } from "./DesktopPetDownloadDialog.js";
import { DesktopPetPacksCardGrid } from "./DesktopPetPacksCardGrid.js";
import { SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";

export function DesktopPetSettings() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const { settings, update } = useSettings();
  const preferLocal = useRef(false);
  const [form, setForm] = useState<DesktopPetPersistedSettings>(() =>
    petFormFromSettings(settings),
  );
  const [hotkeyDraft, setHotkeyDraft] = useState(form.readerHotkey);
  const [findDraft, setFindDraft] = useState("");
  const [findMiss, setFindMiss] = useState(false);
  const [downloadStatus, setDownloadStatus] = useState<DesktopPetDownloadStatus>({ phase: "idle" });
  const [installedPacks, setInstalledPacks] = useState<DesktopPetInstalledPack[]>([]);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);

  const enabled = form.enabled;
  const packDir = form.packDir;
  const packUrl = form.packUrl;
  const readerPath = form.readerPath;
  const bubbleTone = form.bubbleTone;
  const readerHotkey = form.readerHotkey;
  const readerHotkeyMode = form.readerHotkeyMode;

  useEffect(() => {
    if (preferLocal.current || !settings) return;
    const next = petFormFromSettings(settings);
    setForm(next);
    setHotkeyDraft(next.readerHotkey);
  }, [settings]);

  const refreshPacks = () => {
    void platform.listDesktopPetInstalledPacks?.().then((packs) => {
      if (packs) setInstalledPacks(packs);
    });
  };

  useEffect(() => {
    let cancelled = false;
    void platform.getDesktopPetDownloadStatus?.().then((status) => {
      if (!cancelled && status) setDownloadStatus(status);
    });
    const unsubscribe = platform.onDesktopPetDownload?.((status) => {
      setDownloadStatus(status);
      if (status.phase === "ready") {
        refreshPacks();
        setDownloadDialogOpen(false);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [platform]);

  useEffect(() => {
    refreshPacks();
  }, [platform, downloadStatus.phase]);

  useEffect(() => {
    let cancelled = false;
    void platform.getDesktopPetSettings?.().then((saved) => {
      if (cancelled || !saved || preferLocal.current) return;
      preferLocal.current = true;
      const next = {
        enabled: saved.enabled === true,
        packDir: saved.packDir?.trim() ?? "",
        packUrl: saved.packUrl?.trim() ?? "",
        bubbleTone: saved.bubbleTone === "light" ? ("light" as const) : ("dark" as const),
        readerPath: saved.readerPath?.trim() ?? "",
        readerHotkey: normalizeDesktopPetReaderHotkey(saved.readerHotkey),
        readerHotkeyMode: normalizeDesktopPetReaderHotkeyMode(saved.readerHotkeyMode),
      };
      setForm(next);
      setHotkeyDraft(next.readerHotkey);
    });
    return () => {
      cancelled = true;
    };
  }, [platform]);

  const saveReaderHotkey = () => {
    const next = normalizeDesktopPetReaderHotkey(hotkeyDraft);
    setHotkeyDraft(next);
    if (next === readerHotkey) return;
    preferLocal.current = true;
    setForm((current) => ({ ...current, readerHotkey: next }));
    void update({ desktopPetReaderHotkey: next });
  };

  const remember = (patch: Partial<DesktopPetPersistedSettings>) => {
    preferLocal.current = true;
    setForm((current) => ({ ...current, ...patch }));
  };

  const downloadBusy =
    downloadStatus.phase === "downloading" || downloadStatus.phase === "extracting";

  const startDownload = (url: string) => {
    const trimmed = url.trim();
    if (!trimmed || downloadBusy) return;
    setDownloadStatus({ phase: "downloading", received: 0, total: null });
    remember({ packUrl: trimmed, packDir: "" });
    void update({ desktopPetPackUrl: trimmed, desktopPetPackDir: "" });
  };

  const stopDownload = () => {
    setDownloadStatus({ phase: "stopped" });
    void platform.stopDesktopPetDownload?.();
  };

  const usePack = (pack: DesktopPetInstalledPack) => {
    if (downloadBusy) return;
    if (pack.sourceType === "local" && pack.localPath) {
      remember({ packDir: pack.localPath, packUrl: "" });
      void update({ desktopPetPackDir: pack.localPath, desktopPetPackUrl: "" });
    } else if (pack.url) {
      remember({ packUrl: pack.url, packDir: "" });
      void update({ desktopPetPackUrl: pack.url, desktopPetPackDir: "" });
    }
  };

  const handlePackDeleted = (pack: DesktopPetInstalledPack) => {
    if (pack.sourceType === "local" && pack.localPath === packDir) {
      remember({ packDir: "" });
      void update({ desktopPetPackDir: "" });
    } else if (pack.sourceType === "download" && pack.url === packUrl) {
      remember({ packUrl: "" });
      void update({ desktopPetPackUrl: "" });
    }
  };

  const jumpToText = () => {
    const query = findDraft.trim();
    if (!query) return;
    void platform.findDesktopPetReaderText?.(query).then((found) => {
      setFindMiss(found === false);
    });
  };

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPet.enabled" })}
        description={intl.formatMessage({ id: "settings.desktopPetDescription" })}
        control={
          <Switch
            aria-label={intl.formatMessage({ id: "settings.desktopPet.enabled" })}
            checked={enabled}
            onCheckedChange={(checked) => {
              remember({ enabled: checked });
              void update({ desktopPetEnabled: checked });
            }}
          />
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetBubble" })}
        description={intl.formatMessage({ id: "settings.desktopPetBubbleDescription" })}
        control={
          <Select
            value={bubbleTone}
            onValueChange={(value) => {
              const tone = value === "light" ? "light" : "dark";
              remember({ bubbleTone: tone });
              void update({ desktopPetBubbleTone: tone });
            }}
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

      <DesktopPetPacksCardGrid
        packs={installedPacks}
        activeUrl={packUrl}
        packDir={packDir}
        disabled={downloadBusy}
        onUse={usePack}
        onOpenDownload={() => setDownloadDialogOpen(true)}
        onRescan={refreshPacks}
        onDeleted={handlePackDeleted}
      />

      <DesktopPetDownloadDialog
        open={downloadDialogOpen}
        onOpenChange={setDownloadDialogOpen}
        status={downloadStatus}
        onStart={startDownload}
        onStop={stopDownload}
      />

      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReader" })}
        description={
          <>
            {intl.formatMessage({ id: "settings.desktopPetReaderDescription" })}
            {readerPath ? <div className="mt-1 break-all">{readerPath}</div> : null}
          </>
        }
        control={
          <>
            {readerPath ? (
              <Button
                type="button"
                size="lg"
                variant="outline"
                onClick={() => {
                  remember({ readerPath: "" });
                  void update({ desktopPetReaderPath: "" });
                }}
              >
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
                  if (!file) return;
                  remember({ readerPath: file });
                  await update({ desktopPetReaderPath: file });
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
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReaderHotkeyMode" })}
        description={intl.formatMessage({ id: "settings.desktopPetReaderHotkeyModeDescription" })}
        control={
          <Select
            value={readerHotkeyMode}
            onValueChange={(value) => {
              const mode = value === "hold" ? "hold" : "toggle";
              remember({ readerHotkeyMode: mode });
              void update({ desktopPetReaderHotkeyMode: mode });
            }}
          >
            <SelectTrigger
              size="lg"
              className="w-48"
              aria-label={intl.formatMessage({ id: "settings.desktopPetReaderHotkeyMode" })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="toggle">
                {intl.formatMessage({ id: "settings.desktopPetReaderHotkeyMode.toggle" })}
              </SelectItem>
              <SelectItem value="hold">
                {intl.formatMessage({ id: "settings.desktopPetReaderHotkeyMode.hold" })}
              </SelectItem>
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        label={intl.formatMessage({ id: "settings.desktopPetReaderHotkey" })}
        description={intl.formatMessage({ id: "settings.desktopPetReaderHotkeyDescription" })}
        detail={
          <Input
            size="lg"
            value={hotkeyDraft}
            aria-label={intl.formatMessage({ id: "settings.desktopPetReaderHotkey" })}
            onChange={(event) => setHotkeyDraft(event.target.value)}
            onBlur={saveReaderHotkey}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.currentTarget.blur();
            }}
            className="max-w-[520px]"
          />
        }
        control={null}
      />
    </SettingsGroupCard>
  );
}

function petFormFromSettings(
  settings: Partial<AppSettings> | null | undefined,
): DesktopPetPersistedSettings {
  return {
    enabled: settings?.desktopPetEnabled === true,
    packDir: settings?.desktopPetPackDir?.trim() ?? "",
    packUrl: settings?.desktopPetPackUrl?.trim() ?? "",
    bubbleTone: settings?.desktopPetBubbleTone === "light" ? "light" : "dark",
    readerPath: settings?.desktopPetReaderPath?.trim() ?? "",
    readerHotkey: normalizeDesktopPetReaderHotkey(settings?.desktopPetReaderHotkey),
    readerHotkeyMode: normalizeDesktopPetReaderHotkeyMode(settings?.desktopPetReaderHotkeyMode),
  };
}
