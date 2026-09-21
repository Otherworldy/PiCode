import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiHost } from "./extension-ui-host.js";
import type { PiExtensionUiEvent } from "./types.js";

export function createHostExtensionUi(
  host: ExtensionUiHost,
  dispatch: (event: PiExtensionUiEvent) => void,
): ExtensionUIContext {
  const send = (event: Omit<PiExtensionUiEvent, "type"> & { type?: "extension_ui_request" }) => {
    dispatch({ ...event, type: "extension_ui_request" });
  };

  const ui = {
    async select(title: string, options: string[]) {
      const id = randomUUID();
      const waiting = host.wait(id);
      send({ id, method: "select", title, options });
      const response = await waiting;
      if ("cancelled" in response) return undefined;
      return "value" in response ? response.value : undefined;
    },
    async confirm(title: string, message: string) {
      const id = randomUUID();
      const waiting = host.wait(id);
      send({ id, method: "confirm", title, message });
      const response = await waiting;
      return "confirmed" in response && response.confirmed;
    },
    async input(title: string, placeholder?: string) {
      const id = randomUUID();
      const waiting = host.wait(id);
      send({ id, method: "input", title, placeholder });
      const response = await waiting;
      if ("cancelled" in response) return undefined;
      return "value" in response ? response.value : undefined;
    },
    notify(message: string, type?: "info" | "warning" | "error") {
      send({ id: randomUUID(), method: "notify", message, notifyType: type });
    },
    onTerminalInput() {
      return () => undefined;
    },
    setStatus(key: string, text: string | undefined) {
      send({ id: randomUUID(), method: "setStatus", statusKey: key, statusText: text });
    },
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }) {
      send({
        id: randomUUID(),
        method: "setWidget",
        widgetKey: key,
        widgetLines: Array.isArray(content) ? content : undefined,
        widgetPlacement: options?.placement ?? "belowEditor",
      });
    },
    setFooter() {},
    setHeader() {},
    setTitle(title: string) {
      send({ id: randomUUID(), method: "setTitle", title });
    },
    async custom() {
      return undefined as never;
    },
    pasteToEditor() {},
    setEditorText(text: string) {
      send({ id: randomUUID(), method: "set_editor_text", text });
    },
    getEditorText() {
      return "";
    },
    async editor(title: string, prefill?: string) {
      const id = randomUUID();
      const waiting = host.wait(id);
      send({ id, method: "editor", title, prefill });
      const response = await waiting;
      if ("cancelled" in response) return undefined;
      return "value" in response ? response.value : undefined;
    },
    addAutocompleteProvider() {},
    setEditor() {},
  };
  return ui as unknown as ExtensionUIContext;
}
