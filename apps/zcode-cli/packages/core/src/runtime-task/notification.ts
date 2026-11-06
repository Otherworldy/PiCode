import type { ModelUsage } from "@zcode/contracts";
import type { RuntimeTaskType } from "./registry.js";

const TASK_NOTIFICATION_MAX_CHARS = 120_000;

export interface TaskNotificationInput {
  agentId?: string;
  description?: string;
  error?: string;
  outputFile?: string;
  result?: string;
  status: string;
  stderrFile?: string;
  stdoutFile?: string;
  subagentType?: string;
  summary: string;
  taskId: string;
  taskType: RuntimeTaskType;
  toolUseId?: string;
  usage?: {
    durationMs?: number;
    modelUsage?: ModelUsage;
    toolUseCount?: number;
    totalTokens?: number;
  };
}

export function formatTaskNotification(input: TaskNotificationInput): string {
  if (input.taskType === "local_agent") {
    return formatLocalAgentTaskNotification(input);
  }
  if (input.taskType === "local_bash") {
    return formatLocalBashTaskNotification(input);
  }

  const lines = ["<task-notification>", `  <task-id>${escapeXml(input.taskId)}</task-id>`];

  if (input.toolUseId) lines.push(`  <tool-use-id>${escapeXml(input.toolUseId)}</tool-use-id>`);
  lines.push(`  <task-type>${escapeXml(input.taskType)}</task-type>`);
  if (input.agentId) lines.push(`  <agent-id>${escapeXml(input.agentId)}</agent-id>`);
  if (input.subagentType) {
    lines.push(`  <subagent-type>${escapeXml(input.subagentType)}</subagent-type>`);
  }
  if (input.outputFile) lines.push(`  <output-file>${escapeXml(input.outputFile)}</output-file>`);
  if (input.stdoutFile) lines.push(`  <stdout-file>${escapeXml(input.stdoutFile)}</stdout-file>`);
  if (input.stderrFile) lines.push(`  <stderr-file>${escapeXml(input.stderrFile)}</stderr-file>`);
  lines.push(`  <status>${escapeXml(input.status)}</status>`);
  if (input.description) {
    lines.push(`  <description>${escapeXml(input.description)}</description>`);
  }
  lines.push(`  <summary>${escapeXml(input.summary)}</summary>`);
  if (input.result !== undefined) lines.push(`  <result>${escapeXml(input.result)}</result>`);
  if (input.error !== undefined) lines.push(`  <error>${escapeXml(input.error)}</error>`);
  const usage = formatUsage(input.usage);
  if (usage.length > 0) {
    lines.push("  <usage>", ...usage.map((line) => `    ${line}`), "  </usage>");
  }
  lines.push("</task-notification>");

  return truncateTaskNotification(lines.join("\n"));
}

function formatLocalBashTaskNotification(input: TaskNotificationInput): string {
  const lines = ["<task-notification>", `<task-id>${escapeLocalBashXml(input.taskId)}</task-id>`];
  if (input.toolUseId) {
    lines.push(`<tool-use-id>${escapeLocalBashXml(input.toolUseId)}</tool-use-id>`);
  }
  if (input.outputFile) {
    lines.push(`<output-file>${escapeLocalBashXml(input.outputFile)}</output-file>`);
  }
  lines.push(`<status>${escapeLocalBashXml(input.status)}</status>`);
  lines.push(`<summary>${escapeLocalBashXml(input.summary)}</summary>`);
  lines.push("</task-notification>");

  return lines.join("\n");
}

function formatLocalAgentTaskNotification(input: TaskNotificationInput): string {
  const lines = ["<task-notification>", `<task-id>${escapeXml(input.taskId)}</task-id>`];
  if (input.toolUseId) lines.push(`<tool-use-id>${escapeXml(input.toolUseId)}</tool-use-id>`);
  if (input.outputFile) lines.push(`<output-file>${escapeXml(input.outputFile)}</output-file>`);
  lines.push(`<status>${escapeXml(input.status)}</status>`);
  lines.push(`<summary>${escapeXml(input.summary)}</summary>`);
  if (input.result !== undefined) lines.push(`<result>${escapeXml(input.result)}</result>`);
  if (input.error !== undefined) lines.push(`<error>${escapeXml(input.error)}</error>`);

  const usage = formatLocalAgentUsage(input.usage);
  if (usage) lines.push(usage);
  lines.push("</task-notification>");

  return truncateTaskNotification(lines.join("\n"));
}

function formatLocalAgentUsage(input: TaskNotificationInput["usage"]): string | undefined {
  if (!input) return undefined;
  const segments: string[] = [];
  const totalTokens = input.totalTokens ?? input.modelUsage?.totalTokens;
  if (totalTokens !== undefined) {
    segments.push(`<subagent_tokens>${totalTokens}</subagent_tokens>`);
  }
  if (input.toolUseCount !== undefined) {
    segments.push(`<tool_uses>${input.toolUseCount}</tool_uses>`);
  }
  if (input.durationMs !== undefined) {
    segments.push(`<duration_ms>${input.durationMs}</duration_ms>`);
  }
  if (segments.length === 0) return undefined;
  return `<usage>${segments.join("")}</usage>`;
}

function formatUsage(input: TaskNotificationInput["usage"]): string[] {
  if (!input) return [];
  const lines: string[] = [];
  if (input.totalTokens !== undefined) {
    lines.push(`<total-tokens>${input.totalTokens}</total-tokens>`);
  }
  if (input.toolUseCount !== undefined) {
    lines.push(`<tool-uses>${input.toolUseCount}</tool-uses>`);
  }
  if (input.durationMs !== undefined) {
    lines.push(`<duration-ms>${input.durationMs}</duration-ms>`);
  }
  if (input.modelUsage?.inputTokens !== undefined) {
    lines.push(`<input-tokens>${input.modelUsage.inputTokens}</input-tokens>`);
  }
  if (input.modelUsage?.outputTokens !== undefined) {
    lines.push(`<output-tokens>${input.modelUsage.outputTokens}</output-tokens>`);
  }
  if (input.modelUsage?.cacheReadTokens !== undefined) {
    lines.push(`<cache-read-tokens>${input.modelUsage.cacheReadTokens}</cache-read-tokens>`);
  }
  if (input.modelUsage?.cacheWriteTokens !== undefined) {
    lines.push(`<cache-write-tokens>${input.modelUsage.cacheWriteTokens}</cache-write-tokens>`);
  }
  if (input.modelUsage?.reasoningTokens !== undefined) {
    lines.push(`<reasoning-tokens>${input.modelUsage.reasoningTokens}</reasoning-tokens>`);
  }
  return lines;
}

export function truncateTaskNotification(value: string): string {
  if (value.length <= TASK_NOTIFICATION_MAX_CHARS) return value;
  return `${value.slice(0, TASK_NOTIFICATION_MAX_CHARS)}\n[truncated]`;
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&'"]/gu, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      case "'":
        return "&apos;";
      case '"':
        return "&quot;";
      default:
        return char;
    }
  });
}

function escapeLocalBashXml(value: string): string {
  return value.replace(/[<>&]/gu, (char) => {
    switch (char) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "&":
        return "&amp;";
      default:
        return char;
    }
  });
}
