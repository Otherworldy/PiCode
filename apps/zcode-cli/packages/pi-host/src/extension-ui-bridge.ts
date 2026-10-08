import { randomUUID } from "node:crypto";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiHost } from "./extension-ui-host.js";
import type { HostAskAnswer, HostAskQuestion, PiExtensionUiEvent } from "./types.js";

// Pi RPC 的 theme.fg 会写 ANSI。GUI 只存纯文本。
// 缺 theme 时 Plannotator 读 ctx.ui.theme.fg 崩溃，清单和 mark_done 都出不去。
const plainTheme = {
  fg(_color: string, text: string) {
    return text;
  },
  bg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
  italic(text: string) {
    return text;
  },
  underline(text: string) {
    return text;
  },
  inverse(text: string) {
    return text;
  },
  strikethrough(text: string) {
    return text;
  },
  getFgAnsi() {
    return "";
  },
  getBgAnsi() {
    return "";
  },
  getColorMode() {
    return "truecolor" as const;
  },
  getThinkingBorderColor() {
    return (text: string) => text;
  },
  getBashModeBorderColor() {
    return (text: string) => text;
  },
};

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
    async ask(questions: HostAskQuestion[]): Promise<HostAskAnswer[] | undefined> {
      const id = randomUUID();
      const waiting = host.wait(id);
      send({ id, method: "ask", questions });
      const response = await waiting;
      if ("cancelled" in response) return undefined;
      if (!("content" in response) || !response.content) return undefined;
      return mapHostAskAnswers(questions, response.content);
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
    theme: plainTheme,
  };
  return ui as unknown as ExtensionUIContext;
}

function mapHostAskAnswers(
  questions: HostAskQuestion[],
  content: Record<string, unknown>,
): HostAskAnswer[] {
  return questions.map((question, index) => {
    const values = answerValues(content, index, question.question);
    const labels = new Set(question.options.map((option) => option.label));
    const selected = values.filter((value) => labels.has(value));
    const customValues = values.filter((value) => !labels.has(value));
    if (question.multiSelect) {
      const preview = question.options.find(
        (option) => option.preview && selected.includes(option.label),
      )?.preview;
      return {
        question: question.question,
        answer: [...selected, ...customValues].join(", "),
        custom: selected.length === 0 && customValues.length > 0,
        ...(selected.length > 0 ? { selected } : {}),
        ...(preview ? { preview } : {}),
      };
    }
    const answer = values[0] ?? "";
    const chosen = question.options.find((option) => option.label === answer);
    return {
      question: question.question,
      answer,
      custom: !chosen && answer.length > 0,
      ...(chosen?.preview ? { preview: chosen.preview } : {}),
    };
  });
}

function answerValues(
  content: Record<string, unknown>,
  index: number,
  question: string,
): string[] {
  const raw = content[`answer_${index}`];
  if (Array.isArray(raw)) {
    return raw.flatMap((item) =>
      typeof item === "string" && item.trim() ? [item.trim()] : [],
    );
  }
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  const answers = content.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return [];
  const text = (answers as Record<string, unknown>)[question];
  return typeof text === "string" && text.trim() ? [text.trim()] : [];
}
