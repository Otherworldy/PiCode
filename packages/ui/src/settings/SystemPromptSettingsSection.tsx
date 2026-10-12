import type { IFileService } from "@zcode/services";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AgentSystemPromptField } from "@/settings/AgentSystemPromptField.js";
import { SystemPromptEditor } from "@/settings/SystemPromptEditor.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

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
  return (
    <SettingsGroupCard>
      <div className="space-y-8 px-4 py-3">
        <AgentSystemPromptField
          description={intl.formatMessage({ id: "settings.systemPrompt.systemDescription" })}
          fileService={fileService}
          scope="global"
          testIdPrefix="settings-system-prompt"
        />
        <SystemPromptEditor
          description={intl.formatMessage({ id: "settings.systemPrompt.description" })}
          editorLabel={intl.formatMessage({ id: "settings.systemPrompt" })}
          fileService={fileService}
          scope="global"
          testIdPrefix="settings-system-prompt"
        />
      </div>
    </SettingsGroupCard>
  );
}
