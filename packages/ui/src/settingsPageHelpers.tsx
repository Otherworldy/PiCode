/* oxlint-disable eslint(max-lines) -- settings helper 聚合多个设置分组；终端、网络与自动归档多侧能力暂时超过行数限制。 */
import type { LocalePreference, ZCodeInteractionBehavior } from "@zcode/shared";
import { useState, useCallback, useEffect } from "react";
import type { IPlatformService } from "@zcode/shared";
import {
  TID_SETTINGS_LOCALE_SELECT_ITEM,
  TID_SETTINGS_LOCALE_SELECT_TRIGGER,
  testId,
} from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { Input } from "@/components/ui/input.js";
import { Button } from "@/components/ui/button.js";
import { SettingsBadge, SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PiSdkSourceSetting } from "@/settings/PiSdkSourceSetting.js";
import {
  createSettingsPageConfig,
  resolveSettingsSectionForPlatform,
  type SettingsSectionId,
} from "@/settings/settingsPageConfig.js";

export type { Locale, LocalePreference } from "@zcode/shared";
export { type SettingsSectionId };
export { createSettingsPageConfig, resolveSettingsSectionForPlatform };

const ZCODE_INTERACTION_BEHAVIOR_OPTIONS: readonly ZCodeInteractionBehavior[] = ["queue", "guide"];

export function GeneralSectionContent({
  localePreference,
  notificationEnabled,
  notificationSoundEnabled,
  closeToTrayOnWindows,
  keepAwakeWhileRunning = false,
  desktopChromiumHardwareAccelerationEnabled = true,
  terminalInheritSystemProfile = true,
  terminalFontFamily = "",
  httpProxy = "",
  httpProxyNoProxy = "",
  httpProxyCaCertPath = "",
  isDesktop,
  isWindowsDesktop,
  setLocalePreference,
  setNotificationEnabled,
  setNotificationSoundEnabled,
  messageStreamShowReasoning,
  messageStreamShowTodos,
  toolGroupingExploreEnabled,
  toolGroupingTerminalEnabled,
  toolGroupingChangesEnabled,
  zcodeInteractionBehavior,
  onTerminalInheritSystemProfileChange = async () => {},
  onTerminalFontFamilyChange = async () => {},
  onHttpProxyChange = async () => {},
  onHttpProxyNoProxyChange = async () => {},
  onHttpProxyCaCertPathChange = async () => {},
  onCloseToTrayOnWindowsChange,
  onKeepAwakeWhileRunningChange = async () => {},
  onDesktopChromiumHardwareAccelerationChange = async () => {},
  onMessageStreamShowReasoningChange,
  onMessageStreamShowTodosChange,
  onToolGroupingExploreEnabledChange,
  onToolGroupingTerminalEnabledChange,
  onToolGroupingChangesEnabledChange,
  onZCodeInteractionBehaviorChange,
}: {
  localePreference: LocalePreference;
  notificationEnabled: boolean;
  notificationSoundEnabled: boolean;
  closeToTrayOnWindows: boolean;
  keepAwakeWhileRunning?: boolean;
  desktopChromiumHardwareAccelerationEnabled?: boolean;
  terminalInheritSystemProfile: boolean;
  terminalFontFamily: string;
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
  isDesktop?: boolean;
  isWindowsDesktop?: boolean;
  platform?: IPlatformService;
  setLocalePreference: (locale: LocalePreference) => void;
  setNotificationEnabled: (enabled: boolean) => void;
  setNotificationSoundEnabled: (enabled: boolean) => void;
  messageStreamShowReasoning: boolean;
  messageStreamShowTodos: boolean;
  toolGroupingExploreEnabled: boolean;
  toolGroupingTerminalEnabled: boolean;
  toolGroupingChangesEnabled: boolean;
  zcodeInteractionBehavior: ZCodeInteractionBehavior;
  onTerminalInheritSystemProfileChange: (enabled: boolean) => Promise<void>;
  onTerminalFontFamilyChange: (fontFamily: string) => Promise<void>;
  onHttpProxyChange?: (httpProxy: string) => Promise<void>;
  onHttpProxyNoProxyChange?: (noProxy: string) => Promise<void>;
  onHttpProxyCaCertPathChange?: (caCertPath: string) => Promise<void>;
  onCloseToTrayOnWindowsChange: (enabled: boolean) => Promise<void>;
  onKeepAwakeWhileRunningChange?: (enabled: boolean) => Promise<void>;
  onDesktopChromiumHardwareAccelerationChange?: (enabled: boolean) => Promise<void>;
  onMessageStreamShowReasoningChange: (enabled: boolean) => Promise<void>;
  onMessageStreamShowTodosChange: (enabled: boolean) => Promise<void>;
  onToolGroupingExploreEnabledChange: (enabled: boolean) => Promise<void>;
  onToolGroupingTerminalEnabledChange: (enabled: boolean) => Promise<void>;
  onToolGroupingChangesEnabledChange: (enabled: boolean) => Promise<void>;
  onZCodeInteractionBehaviorChange: (behavior: ZCodeInteractionBehavior) => Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  // 部分 SSR 单测会用精简 props 直接渲染本组件，新增终端设置项后旧 helper 未必同步传值。
  // 这里把运行时缺省值兜到“继承系统 profile”，避免 undefined.trim() 把无关测试打断。
  const [localTerminalFontFamily, setLocalTerminalFontFamily] = useState(terminalFontFamily);

  useEffect(() => {
    setLocalTerminalFontFamily(terminalFontFamily);
  }, [terminalFontFamily]);

  const normalizedTerminalFontFamily = localTerminalFontFamily.trim();
  const isTerminalFontFamilyDirty = normalizedTerminalFontFamily !== terminalFontFamily;

  const handleTerminalFontFamilySave = useCallback(async () => {
    await onTerminalFontFamilyChange(normalizedTerminalFontFamily);
  }, [normalizedTerminalFontFamily, onTerminalFontFamilyChange]);

  const [localHttpProxy, setLocalHttpProxy] = useState(httpProxy);

  useEffect(() => {
    setLocalHttpProxy(httpProxy);
  }, [httpProxy]);

  const normalizedHttpProxy = localHttpProxy.trim();
  const isHttpProxyDirty = normalizedHttpProxy !== httpProxy;

  const handleHttpProxySave = useCallback(async () => {
    await onHttpProxyChange(normalizedHttpProxy);
  }, [normalizedHttpProxy, onHttpProxyChange]);

  const [localHttpProxyNoProxy, setLocalHttpProxyNoProxy] = useState(httpProxyNoProxy);

  useEffect(() => {
    setLocalHttpProxyNoProxy(httpProxyNoProxy);
  }, [httpProxyNoProxy]);

  const normalizedHttpProxyNoProxy = localHttpProxyNoProxy
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .join(",");
  const isHttpProxyNoProxyDirty = normalizedHttpProxyNoProxy !== httpProxyNoProxy;

  const handleHttpProxyNoProxySave = useCallback(async () => {
    await onHttpProxyNoProxyChange(normalizedHttpProxyNoProxy);
  }, [normalizedHttpProxyNoProxy, onHttpProxyNoProxyChange]);

  const [localHttpProxyCaCertPath, setLocalHttpProxyCaCertPath] = useState(httpProxyCaCertPath);

  useEffect(() => {
    setLocalHttpProxyCaCertPath(httpProxyCaCertPath);
  }, [httpProxyCaCertPath]);

  const normalizedHttpProxyCaCertPath = localHttpProxyCaCertPath.trim();
  const isHttpProxyCaCertPathDirty = normalizedHttpProxyCaCertPath !== httpProxyCaCertPath;

  const handleHttpProxyCaCertPathSave = useCallback(async () => {
    await onHttpProxyCaCertPathChange(normalizedHttpProxyCaCertPath);
  }, [normalizedHttpProxyCaCertPath, onHttpProxyCaCertPathChange]);

  return (
    <div className="space-y-4">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.locale" })}
          description={intl.formatMessage({ id: "settings.localeDescription" })}
          control={
            <Select
              value={localePreference}
              onValueChange={(value) => setLocalePreference(value as LocalePreference)}
            >
              <SelectTrigger
                size="lg"
                className="w-[260px] min-w-0 justify-between"
                data-testid={TID_SETTINGS_LOCALE_SELECT_TRIGGER}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  value="system"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "system")}
                >
                  {intl.formatMessage({ id: "settings.locale.system" })}
                </SelectItem>
                <SelectItem
                  value="zh-CN"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "zh-CN")}
                >
                  {intl.formatMessage({ id: "settings.locale.zh-CN" })}
                </SelectItem>
                <SelectItem
                  value="en-US"
                  data-testid={testId(TID_SETTINGS_LOCALE_SELECT_ITEM, "en-US")}
                >
                  {intl.formatMessage({ id: "settings.locale.en-US" })}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
      </SettingsGroupCard>

      {isDesktop ? (
        <SettingsGroupCard>
          <PiSdkSourceSetting />
        </SettingsGroupCard>
      ) : null}

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.terminalProfile" })}
          description={intl.formatMessage({ id: "settings.terminalProfileDescription" })}
          control={
            <Switch
              checked={terminalInheritSystemProfile}
              onCheckedChange={(checked) => {
                void onTerminalInheritSystemProfileChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.terminalFontFamily" })}
          description={intl.formatMessage({ id: "settings.terminalFontFamilyDescription" })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isTerminalFontFamilyDirty}
              onClick={() => void handleTerminalFontFamilySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localTerminalFontFamily}
              placeholder={intl.formatMessage({
                id: "settings.terminalFontFamilyPlaceholder",
              })}
              onChange={(event) => {
                setLocalTerminalFontFamily(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isTerminalFontFamilyDirty) {
                  void handleTerminalFontFamilySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxy" })}
          description={intl.formatMessage({ id: "settings.httpProxyDescription" })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyDirty}
              onClick={() => void handleHttpProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxy}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxy(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyDirty) {
                  void handleHttpProxySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {/* No Proxy 与 HTTP 代理共同决定同一出口策略，必须贴在代理地址下面。*/}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyNoProxy" })}
          description={intl.formatMessage({
            id: "settings.httpProxyNoProxyDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyNoProxyDirty}
              onClick={() => void handleHttpProxyNoProxySave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyNoProxy}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyNoProxyPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyNoProxy(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyNoProxyDirty) {
                  void handleHttpProxyNoProxySave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
        {/* 自定义 CA 属于 HTTP 代理的同一网络出口策略，必须跟代理输入放在同一卡片里。*/}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.httpProxyCaCertPath" })}
          description={intl.formatMessage({
            id: "settings.httpProxyCaCertPathDescription",
          })}
          control={
            <Button
              type="button"
              size="lg"
              disabled={!isHttpProxyCaCertPathDirty}
              onClick={() => void handleHttpProxyCaCertPathSave()}
            >
              {intl.formatMessage({ id: "settings.dataBaseDirSave" })}
            </Button>
          }
          detail={
            <Input
              size="lg"
              value={localHttpProxyCaCertPath}
              placeholder={intl.formatMessage({
                id: "settings.httpProxyCaCertPathPlaceholder",
              })}
              onChange={(event) => {
                setLocalHttpProxyCaCertPath(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && isHttpProxyCaCertPathDirty) {
                  void handleHttpProxyCaCertPathSave();
                }
              }}
              className="max-w-[520px] font-mono"
            />
          }
        />
      </SettingsGroupCard>

      <SettingsGroupCard>
        {isDesktop ? (
          <>
            <SettingsRow
              label={intl.formatMessage({
                id: "settings.desktopChromiumHardwareAcceleration",
              })}
              description={intl.formatMessage({
                id: "settings.desktopChromiumHardwareAccelerationDescription",
              })}
              control={
                <Switch
                  aria-label={intl.formatMessage({
                    id: "settings.desktopChromiumHardwareAcceleration",
                  })}
                  checked={desktopChromiumHardwareAccelerationEnabled}
                  onCheckedChange={(checked) => {
                    void onDesktopChromiumHardwareAccelerationChange(checked);
                  }}
                />
              }
            />
          </>
        ) : null}
        <SettingsRow
          label={intl.formatMessage({ id: "settings.notification" })}
          description={intl.formatMessage({
            id: "settings.notificationDescription",
          })}
          control={
            <Switch checked={notificationEnabled} onCheckedChange={setNotificationEnabled} />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.notificationSound" })}
          description={intl.formatMessage({
            id: "settings.notificationSoundDescription",
          })}
          control={
            <Switch
              checked={notificationSoundEnabled}
              disabled={!notificationEnabled}
              onCheckedChange={setNotificationSoundEnabled}
            />
          }
        />
        {isWindowsDesktop ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.closeToTrayOnWindows" })}
            description={intl.formatMessage({
              id: "settings.closeToTrayOnWindowsDescription",
            })}
            control={
              <Switch
                checked={closeToTrayOnWindows}
                onCheckedChange={(checked) => {
                  void onCloseToTrayOnWindowsChange(checked);
                }}
              />
            }
          />
        ) : null}
        {isDesktop ? (
          <SettingsRow
            label={intl.formatMessage({ id: "settings.keepAwakeWhileRunning" })}
            description={intl.formatMessage({
              id: "settings.keepAwakeWhileRunningDescription",
            })}
            control={
              <Switch
                aria-label={intl.formatMessage({
                  id: "settings.keepAwakeWhileRunning",
                })}
                checked={keepAwakeWhileRunning}
                onCheckedChange={(checked) => {
                  void onKeepAwakeWhileRunningChange(checked);
                }}
              />
            }
          />
        ) : null}
      </SettingsGroupCard>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.zcodeInteractionBehavior" })}
          description={intl.formatMessage({
            id: "settings.zcodeInteractionBehaviorDescription",
          })}
          control={
            <Select
              value={zcodeInteractionBehavior}
              onValueChange={(value) => {
                void onZCodeInteractionBehaviorChange(value as ZCodeInteractionBehavior);
              }}
            >
              <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ZCODE_INTERACTION_BEHAVIOR_OPTIONS.map((behavior) => (
                  <SelectItem key={behavior} value={behavior}>
                    {intl.formatMessage({
                      id: `settings.zcodeInteractionBehavior.option.${behavior}`,
                    })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.messageStreamShowReasoning" })}
          description={intl.formatMessage({
            id: "settings.messageStreamShowReasoningDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.messageStreamShowReasoning" })}
              checked={messageStreamShowReasoning}
              onCheckedChange={(checked) => {
                void onMessageStreamShowReasoningChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.messageStreamShowTodos" })}
          description={intl.formatMessage({
            id: "settings.messageStreamShowTodosDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.messageStreamShowTodos" })}
              checked={messageStreamShowTodos}
              onCheckedChange={(checked) => {
                void onMessageStreamShowTodosChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.toolGroupingExplore" })}
          description={intl.formatMessage({
            id: "settings.toolGroupingExploreDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.toolGroupingExplore" })}
              checked={toolGroupingExploreEnabled}
              onCheckedChange={(checked) => {
                void onToolGroupingExploreEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.toolGroupingTerminal" })}
          description={intl.formatMessage({
            id: "settings.toolGroupingTerminalDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.toolGroupingTerminal" })}
              checked={toolGroupingTerminalEnabled}
              onCheckedChange={(checked) => {
                void onToolGroupingTerminalEnabledChange(checked);
              }}
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.toolGroupingChanges" })}
          description={intl.formatMessage({
            id: "settings.toolGroupingChangesDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({ id: "settings.toolGroupingChanges" })}
              checked={toolGroupingChangesEnabled}
              onCheckedChange={(checked) => {
                void onToolGroupingChangesEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}

export function GeneralSectionHeader({ localePreference }: { localePreference: LocalePreference }) {
  const { intl } = useZCodeIntl();

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <SettingsBadge>
        {intl.formatMessage({ id: `settings.locale.${localePreference}` })}
      </SettingsBadge>
    </div>
  );
}
