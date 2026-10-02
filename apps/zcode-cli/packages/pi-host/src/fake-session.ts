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
  holdNavigate = false;
  summaryAborted = false;
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
    _options?: { summarize?: boolean; customInstructions?: string },
  ): Promise<{ editorText?: string; cancelled?: boolean }> {
    this.navigatedTo.push(targetId);
    if (this.holdNavigate) await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      cancelled: this.summaryAborted,
      ...(this.editorText ? { editorText: this.editorText } : {}),
    };
  }

  abortBranchSummary(): void {
    this.summaryAborted = true;
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
