import type { PiHostEvent, PiSessionPort, PiSessionTreeNode } from "./types.js";

export class FakePiSession implements PiSessionPort {
  sessionId: string;
  sessionFile?: string;
  isStreaming = false;
  private readonly listeners = new Set<(event: PiHostEvent) => void>();
  events: PiHostEvent[] = [];
  prompts: string[] = [];
  promptImages: Array<Array<{ type: "image"; data: string; mimeType: string }>> = [];
  steers: string[] = [];
  followUps: string[] = [];
  aborted = false;
  compacted = false;
  acceptPrompt = true;
  navigatedTo: string[] = [];
  navigateOptions?: { summarize?: boolean; customInstructions?: string };
  holdNavigate = false;
  holdSummary = false;
  summaryAborted = false;
  summaryStarted = false;
  abandonedEntries: readonly unknown[] = [{ id: "dropped" }];
  editorText?: string;
  contextEventsList: PiHostEvent[] = [];
  isCompacting = false;
  tree: PiSessionTreeNode[] = [];
  branchFrom?: (entryId: string) => { sessionId: string; sessionFile: string };

  constructor(sessionId: string, sessionFile?: string) {
    this.sessionId = sessionId;
    this.sessionFile = sessionFile;
  }

  emit(event: PiHostEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
  }

  async prompt(
    text: string,
    options?: { images?: Array<{ type: "image"; data: string; mimeType: string }> },
  ): Promise<boolean> {
    this.prompts.push(text);
    this.promptImages.push(options?.images ?? []);
    return this.acceptPrompt;
  }

  async steer(text: string): Promise<void> {
    this.steers.push(text);
  }

  async followUp(text: string): Promise<void> {
    this.followUps.push(text);
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.isStreaming = false;
  }

  async compact(): Promise<void> {
    this.compacted = true;
  }

  async navigateTree(
    targetId: string,
    options?: { summarize?: boolean; customInstructions?: string },
  ): Promise<{ editorText?: string; cancelled?: boolean }> {
    this.navigatedTo.push(targetId);
    this.navigateOptions = options;
    if (this.holdNavigate) await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      cancelled: this.summaryAborted,
      ...(this.editorText ? { editorText: this.editorText } : {}),
    };
  }

  abortBranchSummary(): void {
    this.summaryAborted = true;
  }

  captureAbandonedBranch(): { entries: readonly unknown[] } | undefined {
    return this.abandonedEntries.length > 0 ? { entries: this.abandonedEntries } : undefined;
  }

  async summarizeAbandonedBranch(
    _captured: { entries: readonly unknown[] },
    options?: { customInstructions?: string },
  ): Promise<{ cancelled: boolean; summary?: string }> {
    this.summaryStarted = true;
    this.navigateOptions = {
      summarize: true,
      ...(options?.customInstructions ? { customInstructions: options.customInstructions } : {}),
    };
    if (this.holdSummary) await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.summaryAborted) return { cancelled: true };
    return { cancelled: false, summary: "dropped the rest" };
  }

  readTree(): PiSessionTreeNode[] {
    return this.tree;
  }

  contextEvents(): PiHostEvent[] {
    return this.contextEventsList;
  }

  subscribe(listener: (event: PiHostEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
  }
}
