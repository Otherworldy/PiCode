import {
  TID_WORKSPACE_MEMORY_EDITOR,
  TID_WORKSPACE_MEMORY_EDITOR_CANCEL,
  TID_WORKSPACE_MEMORY_EDITOR_CONTENT,
  TID_WORKSPACE_MEMORY_EDITOR_NAME,
  TID_WORKSPACE_MEMORY_EDITOR_SAVE,
} from "@picode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const MEMORY_ITEM_FILE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}\.md$/;

export function isValidWorkspaceMemoryFileName(fileName: string): boolean {
  return fileName === MEMORY_INDEX_FILE_NAME || MEMORY_ITEM_FILE_PATTERN.test(fileName);
}

export interface WorkspaceMemoryEditorState {
  fileName: string;
  originalFileName: string;
  content: string;
  originalContent: string;
  isNew: boolean;
}

export function WorkspaceMemoryEditor({
  editor,
  error,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  editor: WorkspaceMemoryEditorState;
  error: string | null;
  saving: boolean;
  onChange: (patch: Partial<WorkspaceMemoryEditorState>) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 p-4"
      data-testid={TID_WORKSPACE_MEMORY_EDITOR}
    >
      {editor.isNew ? (
        <Input
          autoFocus
          data-testid={TID_WORKSPACE_MEMORY_EDITOR_NAME}
          placeholder={intl.formatMessage({
            id: "settings.memory.viewer.fileNamePlaceholder",
          })}
          size="lg"
          value={editor.fileName}
          onChange={(event) => onChange({ fileName: event.target.value })}
        />
      ) : null}
      <Textarea
        data-testid={TID_WORKSPACE_MEMORY_EDITOR_CONTENT}
        className="min-h-0 flex-1 resize-none rounded-lg border border-input-border bg-input p-2.5 font-mono text-ui-base hover:border-input-border-hover focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0"
        placeholder={intl.formatMessage({
          id: "settings.memory.viewer.fileContentPlaceholder",
        })}
        value={editor.content}
        onChange={(event) => onChange({ content: event.target.value })}
      />
      {error ? (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          data-testid={TID_WORKSPACE_MEMORY_EDITOR_CANCEL}
          size="lg"
          type="button"
          variant="outline"
          onClick={onCancel}
        >
          {intl.formatMessage({ id: "settings.memory.viewer.cancel" })}
        </Button>
        <Button
          data-testid={TID_WORKSPACE_MEMORY_EDITOR_SAVE}
          disabled={saving || !editor.fileName.trim()}
          size="lg"
          type="button"
          onClick={onSave}
        >
          {intl.formatMessage({ id: "settings.memory.viewer.save" })}
        </Button>
      </div>
    </div>
  );
}
