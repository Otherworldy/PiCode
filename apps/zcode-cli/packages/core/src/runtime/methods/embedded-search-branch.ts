import type { ModelToolContract } from "../deps.js";
import { registerBuiltInTools } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { resolveEmbeddedSearchBranchCapability } from "../../embedded-search/capability.js";
import { resolveBuiltInToolAllowlist } from "../helpers/tool-allowlist.js";
import { isToolNameDisallowed } from "../../tool/tool-visibility.js";

export function resolveRuntimeEmbeddedSearchEnabled(runtime: AgentRuntimeInternal): boolean {
  const builtInToolAllowlist = resolveBuiltInToolAllowlist(runtime.config);
  const decision = resolveEmbeddedSearchBranchCapability({
    bashAvailable:
      (builtInToolAllowlist === undefined || builtInToolAllowlist.includes("Bash")) &&
      !isToolNameDisallowed("Bash", runtime.config.toolDisallowlist),
  });
  return decision.useEmbeddedSearchBranch;
}

export function refreshBranchAwareBuiltInTools(runtime: AgentRuntimeInternal): void {
  const embeddedSearchEnabled = resolveRuntimeEmbeddedSearchEnabled(runtime);
  if (embeddedSearchEnabled) {
    runtime.registry.unregister("Glob");
    runtime.registry.unregister("Grep");
  }

  registerBuiltInTools(runtime.registry, {
    bashTimeoutPolicy: runtime.config.bashTimeoutPolicy,
    includeSkill: Boolean(runtime.skillPort),
    includeAgent: Boolean(runtime.subagentPort),
    embeddedSearchEnabled,
    agentProfiles: runtime.config.subagents?.profiles,
    builtInToolOverrides: runtime.config.subagents?.builtInToolOverrides,
    allowedTools: resolveBuiltInToolAllowlist(runtime.config),
    disallowedTools: runtime.config.toolDisallowlist,
    silentDuplicateWarnings: true,
  });
  runtime.cachedTools = null;
}

export function filterEmbeddedSearchRuntimeVisibleTools(
  runtime: AgentRuntimeInternal,
  tools: ModelToolContract[],
): ModelToolContract[] {
  if (!resolveRuntimeEmbeddedSearchEnabled(runtime)) return tools;
  return tools.filter((tool) => tool.name !== "Glob" && tool.name !== "Grep");
}
