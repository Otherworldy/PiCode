import { useState } from "react";
import type { IFileService } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AgentSystemPromptField } from "@/settings/AgentSystemPromptField.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { SystemPromptEditor } from "@/settings/SystemPromptEditor.js";

type PromptTab = "append" | "replace" | "commands";

export function SystemPromptSettingsSection({
  fileService,
}: {
  fileService: Pick<
    IFileService,
    | "deleteAgentPrompt"
    | "listAgentPrompts"
    | "readAgentPrompt"
    | "readAgentSystemPrompt"
    | "writeAgentPrompt"
    | "writeAgentSystemPrompt"
  >;
}) {
  const { intl } = useZCodeIntl();
  const [tab, setTab] = useState<PromptTab>("append");
  return (
    <div className="space-y-3">
      <SettingsSegmentedTabs
        items={[
          {
            value: "append",
            label: intl.formatMessage({ id: "settings.systemPrompt.append" }),
          },
          {
            value: "replace",
            label: intl.formatMessage({ id: "settings.systemPrompt.replace" }),
          },
          {
            value: "commands",
            label: intl.formatMessage({ id: "settings.systemPrompt.commands" }),
          },
        ]}
        onValueChange={setTab}
        value={tab}
      />
      <SettingsGroupCard>
        <div className="px-4 py-3">
          <div className={tab === "append" ? undefined : "hidden"}>
            <AgentSystemPromptField
              description={intl.formatMessage({ id: "settings.systemPrompt.appendDescription" })}
              fileService={fileService}
              kind="append"
              scope="global"
              testIdPrefix="settings-system-prompt"
            />
          </div>
          <div className={tab === "replace" ? undefined : "hidden"}>
            <AgentSystemPromptField
              description={intl.formatMessage({ id: "settings.systemPrompt.systemDescription" })}
              fileService={fileService}
              kind="replace"
              scope="global"
              testIdPrefix="settings-system-prompt"
            />
          </div>
          <div className={tab === "commands" ? undefined : "hidden"}>
            <SystemPromptEditor
              description={intl.formatMessage({ id: "settings.systemPrompt.description" })}
              editorLabel={intl.formatMessage({ id: "settings.systemPrompt.commands" })}
              fileService={fileService}
              scope="global"
              testIdPrefix="settings-system-prompt"
            />
          </div>
        </div>
      </SettingsGroupCard>
    </div>
  );
}
