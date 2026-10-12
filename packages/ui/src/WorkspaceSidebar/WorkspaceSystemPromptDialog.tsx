import type { IFileService } from "@zcode/services";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AgentSystemPromptField } from "@/settings/AgentSystemPromptField.js";
import { SystemPromptEditor } from "@/settings/SystemPromptEditor.js";

export function WorkspaceSystemPromptDialog({
  fileService,
  onOpenChange,
  open,
  workspaceLabel,
  workspacePath,
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
  onOpenChange: (open: boolean) => void;
  open: boolean;
  workspaceLabel: string;
  workspacePath: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-4rem)] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "workspaceSidebar.systemPrompt" })}</DialogTitle>
          <DialogDescription className="break-all">{workspaceLabel}</DialogDescription>
        </DialogHeader>
        {open ? (
          <div className="space-y-8">
            <AgentSystemPromptField
              description={intl.formatMessage({
                id: "settings.systemPrompt.systemProjectDescription",
              })}
              fileService={fileService}
              rootPath={workspacePath}
              scope="project"
              testIdPrefix="workspace-system-prompt"
            />
            <SystemPromptEditor
              description={intl.formatMessage({ id: "workspaceSidebar.systemPrompt.description" })}
              editorLabel={intl.formatMessage({ id: "workspaceSidebar.systemPrompt" })}
              fileService={fileService}
              rootPath={workspacePath}
              scope="project"
              testIdPrefix="workspace-system-prompt"
            />
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
