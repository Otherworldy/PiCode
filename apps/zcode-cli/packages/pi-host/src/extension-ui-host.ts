import type { PendingInteraction } from "@zcode/shared/zcode-protocol-v4";
import { EMPTY_PLUGIN_VIEW_REGISTRY, type PluginViewRegistry } from "./plugin-adapters/registry.js";
import type { PiExtensionUiEvent, PiExtensionUiResponse } from "./types.js";

export type ExtensionUiSideEffect =
  | { kind: "notify"; message: string; notifyType: "info" | "warning" | "error" }
  | { kind: "title"; title: string }
  | { kind: "editorText"; text: string }
  | { kind: "projectTrust"; id: string; title: string };

export interface ExtensionUiState {
  pending: PendingInteraction[];
  widgets: Array<{ key: string; lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  statuses: Array<{ key: string; text: string }>;
  sideEffects: ExtensionUiSideEffect[];
}

type PendingDialog = {
  id: string;
  resolve: (response: PiExtensionUiResponse) => void;
};

export class ExtensionUiHost {
  autoConfirm = false;
  private readonly dialogs = new Map<string, PendingDialog>();
  private readonly queued = new Map<string, PiExtensionUiResponse>();
  private pending: PendingInteraction[] = [];
  private widgets: ExtensionUiState["widgets"] = [];
  private statuses: ExtensionUiState["statuses"] = [];

  constructor(private readonly views: PluginViewRegistry = EMPTY_PLUGIN_VIEW_REGISTRY) {}

  snapshot(): Omit<ExtensionUiState, "sideEffects"> {
    return { pending: this.pending, widgets: this.widgets, statuses: this.statuses };
  }

  askPermission(input: {
    id: string;
    toolName: string;
    summary: string;
    detail?: unknown;
  }): Omit<ExtensionUiState, "sideEffects"> {
    if (this.autoConfirm) {
      this.deliver({ id: input.id, confirmed: true });
      return this.snapshot();
    }
    this.pending = [
      ...this.pending,
      {
        interactionId: input.id,
        kind: "permission",
        anchorRowId: null,
        createdAt: Date.now(),
        payload: {
          kind: "permission",
          toolCallId: input.id,
          toolName: input.toolName,
          summary: input.summary,
          detail: input.detail ?? {},
          options: [
            { optionId: "allowOnce", label: "Allow once", kind: "allowOnce" },
            { optionId: "allowAlways", label: "Allow for session", kind: "allowAlways" },
            { optionId: "deny", label: "Block", kind: "deny" },
          ],
        },
      },
    ];
    return this.snapshot();
  }

  handle(event: PiExtensionUiEvent): ExtensionUiState {
    const sideEffects: ExtensionUiSideEffect[] = [];
    switch (event.method) {
      case "notify":
        sideEffects.push({
          kind: "notify",
          message: event.message ?? "",
          notifyType: event.notifyType ?? "info",
        });
        break;
      case "setTitle":
        if (event.title) sideEffects.push({ kind: "title", title: event.title });
        break;
      case "set_editor_text":
        sideEffects.push({ kind: "editorText", text: event.text ?? "" });
        break;
      case "setStatus":
        this.statuses = this.upsert(
          this.statuses,
          event.statusKey ?? "default",
          event.statusText === undefined
            ? undefined
            : { key: event.statusKey ?? "default", text: event.statusText },
        );
        break;
      case "setWidget":
        this.widgets = this.upsertWidget(event);
        break;
      case "custom":
        this.widgets = this.upsertWidget({
          ...event,
          widgetKey: event.widgetKey ?? event.pluginId ?? "custom",
          widgetLines: this.views.resolveCustom({
            pluginId: event.pluginId,
            view: event.view,
            state: event.state,
          }),
          widgetPlacement: event.widgetPlacement ?? "aboveEditor",
        });
        break;
      case "confirm":
        if (this.autoConfirm) {
          this.deliver({ id: event.id, confirmed: true });
          break;
        }
        this.pending = [...this.pending, this.toConfirm(event)];
        break;
      case "select":
      case "input":
      case "editor":
        // 完全访问只跳过工具授权和 confirm。提问仍要人答，和 Pi 一样。
        this.pending = [...this.pending, this.toInput(event)];
        break;
      default:
        break;
    }
    return { pending: this.pending, widgets: this.widgets, statuses: this.statuses, sideEffects };
  }

  wait(id: string): Promise<PiExtensionUiResponse> {
    const queued = this.queued.get(id);
    if (queued) {
      this.queued.delete(id);
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this.dialogs.set(id, { id, resolve });
    });
  }

  respond(response: PiExtensionUiResponse): boolean {
    this.pending = this.pending.filter((item) => item.interactionId !== response.id);
    return this.deliver(response);
  }

  private deliver(response: PiExtensionUiResponse): boolean {
    const dialog = this.dialogs.get(response.id);
    if (!dialog) {
      this.queued.set(response.id, response);
      return false;
    }
    this.dialogs.delete(response.id);
    dialog.resolve(response);
    return true;
  }

  private upsert<T extends { key: string }>(list: T[], key: string, next: T | undefined): T[] {
    const without = list.filter((item) => item.key !== key);
    return next ? [...without, next] : without;
  }

  private upsertWidget(event: PiExtensionUiEvent): ExtensionUiState["widgets"] {
    const key = event.widgetKey ?? "default";
    if (!event.widgetLines) return this.widgets.filter((item) => item.key !== key);
    return this.upsert(this.widgets, key, {
      key,
      lines: event.widgetLines,
      placement: event.widgetPlacement ?? "aboveEditor",
    });
  }

  private toConfirm(event: PiExtensionUiEvent): PendingInteraction {
    return {
      interactionId: event.id,
      kind: "userInput",
      anchorRowId: null,
      createdAt: Date.now(),
      payload: {
        kind: "userInput",
        prompt: event.message ?? event.title ?? "Confirm",
        freeText: false,
        options: [
          { optionId: "yes", label: "Allow" },
          { optionId: "no", label: "Block" },
        ],
      },
    };
  }

  private toInput(event: PiExtensionUiEvent): PendingInteraction {
    const rawOptions = event.options ?? [];
    const options = rawOptions.map((label) => ({ optionId: label, label }));
    const questions =
      event.method === "select" ? askSelectQuestions(event.title ?? "", rawOptions) : undefined;
    return {
      interactionId: event.id,
      kind: "userInput",
      anchorRowId: null,
      createdAt: Date.now(),
      payload: {
        kind: "userInput",
        prompt: questions?.[0]?.question ?? event.title ?? event.message ?? "",
        freeText: event.method !== "select",
        ...(options.length > 0 ? { options } : {}),
        ...(questions ? { questions } : {}),
      },
    };
  }
}

const CUSTOM_OPTION = /^\d+\.\s+(?:自己输入|Type something\.)$/;

/** Pi ask 的选项是 `1. 标签 — 说明`。拆开给问卷；value 仍是原行，回答才能对回去。 */
function askSelectQuestions(title: string, rawOptions: string[]) {
  const choices = rawOptions.filter((label) => !CUSTOM_OPTION.test(label));
  if (choices.length === 0) return undefined;
  const headerMatch = /^\[([^\]]{1,16})\]\s*/.exec(title);
  const question = (headerMatch ? title.slice(headerMatch[0].length) : title).trim() || title;
  return [
    {
      question,
      header: headerMatch?.[1] ?? "Ask",
      options: choices.map((raw) => {
        const body = raw.replace(/^\d+\.\s+/, "");
        const cut = body.indexOf(" \u2014 ");
        const label = (cut >= 0 ? body.slice(0, cut) : body).trim() || raw;
        const description = cut >= 0 ? body.slice(cut + 3).trim() : "";
        return { value: raw, label, ...(description ? { description } : {}) };
      }),
    },
  ];
}
