import type { AgentSummary } from "@picode/shared";
import { buildSubagentMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import type { SubagentMessageFormatter } from "@/lib/subagentDisplayName.js";
import { subagentDisplayDescription, subagentDisplayName } from "@/lib/subagentDisplayName.js";

type MessageFormatter = SubagentMessageFormatter;

type SubagentMentionInput = Pick<
  AgentSummary,
  "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
>;

function getSubagentSourcePriority(agent: SubagentMentionInput): number {
  if (agent.scope === "workspace") {
    return 0;
  }
  if (agent.source === "user") {
    return 1;
  }
  return 2;
}

function getSubagentSourceLabel(agent: SubagentMentionInput): string {
  if (agent.scope === "workspace") {
    return "Workspace";
  }
  if (agent.source === "plugin") {
    return "Plugin";
  }
  if (agent.source === "built-in") {
    return "Built-in";
  }
  return "User";
}

export function mapSubagentsToMentionItems(
  agents: SubagentMentionInput[],
  formatMessage: MessageFormatter,
): MentionItem[] {
  const uniqueAgentsByName = new Map<string, SubagentMentionInput>();
  for (const agent of agents) {
    if (!agent.enabled) {
      continue;
    }
    const key = agent.name.trim().toLowerCase();
    if (!key) {
      continue;
    }
    const current = uniqueAgentsByName.get(key);
    if (!current || getSubagentSourcePriority(agent) < getSubagentSourcePriority(current)) {
      uniqueAgentsByName.set(key, agent);
    }
  }

  return [...uniqueAgentsByName.values()].map((agent) => {
    const sourceLabel = getSubagentSourceLabel(agent);
    const model = agent.modelSelection
      ? `${agent.modelSelection.providerId}/${agent.modelSelection.modelId}`
      : undefined;
    // 展示走当前语言，关键词两种名字都收：列表里能看见「实现」，用户也会搜 `worker`。
    const displayName = subagentDisplayName(agent.name, formatMessage);
    const description = subagentDisplayDescription(agent.name, agent.description, formatMessage);
    return {
      id: `subagent:${agent.id}`,
      category: "subagents",
      label: displayName,
      description: description ? `${sourceLabel} · ${description}` : sourceLabel,
      value: agent.name,
      markdown: buildSubagentMentionMarkdown(agent.name),
      keywords: [
        displayName,
        agent.name,
        description,
        agent.description,
        agent.scope,
        agent.source,
        sourceLabel,
        model ?? "",
        agent.path,
      ],
      data: {
        path: agent.path,
        scope: agent.scope,
        source: agent.source,
        model,
      },
    } satisfies MentionItem;
  });
}
