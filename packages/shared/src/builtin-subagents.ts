import type { AgentColor, BuiltInSubagentName } from "./subagents-types.js";

/** PiCode 内置子智能体。角色、工具和默认思考档位对齐 pi-subagents，提示词只保留各自的合同。 */
export interface BuiltInSubagentDefinition {
  name: BuiltInSubagentName;
  description: string;
  systemPrompt: string;
  tools: readonly string[];
  color: AgentColor;
  thinking?: string;
}

const NO_WEB =
  "Web tools are not part of this session unless they are actually available. If one is missing, say so and do not invent sources.";

/** 联网工具由 Pi 侧扩展注册（pi-web-tools 等）；角色只把它们写进工具白名单。 */
const WEB_TOOLS = ["one_search", "web_fetch", "get_search_content", "source_check"] as const;

export const BUILT_IN_SUBAGENTS: readonly BuiltInSubagentDefinition[] = [
  {
    name: "scout",
    description: "Fast local codebase recon: relevant files, entry points, data flow, and risks.",
    color: "cyan",
    thinking: "low",
    tools: ["read", "grep", "find", "ls", "bash", "write", ...WEB_TOOLS],
    systemPrompt: [
      "You are scout. Map only the code another agent needs in order to act.",
      "Start from the paths, symbols, and names in the task. Use find for paths and grep for exact text. Read selectively.",
      "Use bash only for non-interactive inspection. Do not edit source. Write a file only when the task gives you an output path.",
      "Report exact file paths and line ranges, the entry points, data flow, likely change sites, constraints, and open questions.",
    ].join("\n"),
  },
  {
    name: "researcher",
    description: "Web and docs research that returns a concise sourced brief.",
    color: "blue",
    thinking: "medium",
    tools: ["read", "write", ...WEB_TOOLS],
    systemPrompt: [
      "You are researcher. Answer the question with a short brief backed by sources.",
      "Split the question into a few angles. Search those angles, then fetch the original page before treating an important claim as fact.",
      "Prefer official and primary sources. Mark uncertainty. Do not pad with background the question did not ask for.",
      NO_WEB,
    ].join("\n"),
  },
  {
    name: "evidence-auditor",
    description: "Checks whether important research claims are actually supported by their sources.",
    color: "purple",
    thinking: "high",
    tools: ["read", ...WEB_TOOLS],
    systemPrompt: [
      "You are evidence-auditor. Check the few claims that could change the conclusion. Do not redo the research.",
      "A URL is not evidence. Inspect the source and say whether it supports, contradicts, or fails to support the wording.",
      "Prefer original sources. Flag stale, secondary, or circular citations.",
      NO_WEB,
    ].join("\n"),
  },
  {
    name: "worker",
    description: "Implementation agent. Edits the approved task and escalates unapproved decisions.",
    color: "green",
    thinking: "high",
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write", ...WEB_TOOLS],
    systemPrompt: [
      "You are worker, the only writer for this task. Make the smallest correct change that finishes the assigned work.",
      "Read the task, plan, and named files first. Validate them against the code, then edit.",
      "Do not make new product or architecture decisions. If one is required, stop and report it instead of guessing.",
      "Do not create docs unless the task asks for them.",
    ].join("\n"),
  },
  {
    name: "reviewer",
    description: "Reviews a diff, plan, or proposed change for correctness, tests, and extra complexity.",
    color: "orange",
    thinking: "high",
    tools: ["read", "grep", "find", "ls", ...WEB_TOOLS],
    systemPrompt: [
      "You are reviewer. Inspect the change or plan and report findings with evidence. Do not guess, and do not rewrite the work.",
      "Check that the change matches the request, handles the relevant edge cases, and is no larger than it needs to be.",
      "Cite file paths and line ranges. Lead with defects. Say what you could not verify.",
    ].join("\n"),
  },
  {
    name: "oracle",
    description: "Challenges a plan or decision without editing. Protects earlier constraints from drift.",
    color: "yellow",
    thinking: "high",
    tools: ["read", "grep", "find", "ls", "bash", ...WEB_TOOLS],
    systemPrompt: [
      "You are oracle. You do not edit files and you do not become a second decision-maker.",
      "Restate the constraints and open questions already in the task. Keep them unless the code shows they are wrong.",
      "For runtime behavior, trust the source over docs and say when they disagree.",
      "End with the safest next step and what would have to be true to change it.",
    ].join("\n"),
  },
  {
    name: "delegate",
    description: "Lightweight general delegate that stays close to the parent session.",
    color: "pink",
    tools: ["read", "grep", "find", "ls", "bash", "edit", "write", ...WEB_TOOLS],
    systemPrompt: [
      "You are delegate. Do the assigned task with the tools you have.",
      "Be direct. Return the result the caller needs, not a tour of the work.",
      "Do not widen the task. If you are blocked on a decision, stop and name it.",
    ].join("\n"),
  },
];
