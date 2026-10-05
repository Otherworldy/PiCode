// Composer Skill 只读 catalog。
// 与 Skills Settings 管理接口分离：这里的 sessionId 决定 authority，不提供启停/删除能力。
import {
  zcodeSkillsReferenceCatalogParamsSchema,
  type ZCodeSkillReferenceCatalogEntry,
  type ZCodeSkillsReferenceCatalogResult,
} from "@zcode/shared";
import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import { listPiSkills, type PiSkillView } from "@zcode/pi-host";
import {
  parseParams,
  requireSession,
  type ZCodeProtocolAgentServerContext,
} from "./server-types.js";

export async function getSkillReferenceCatalog(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeSkillsReferenceCatalogResult> {
  const params = parseParams(zcodeSkillsReferenceCatalogParamsSchema, rawParams);
  if (params.sessionId) {
    const record = requireSession(context, params.sessionId);
    const loaded = (
      record.app as { piHosted?: { listSkills?: () => PiSkillView[] } }
    ).piHosted?.listSkills?.();
    if (loaded) return toResult("session", piSkillsToOutcome(loaded));
    if (typeof record.app.getSkillCatalog === "function") {
      return toResult("session", await record.app.getSkillCatalog());
    }
    return toResult("session", piSkillsToOutcome(await listPiSkills(record.workspace.workspacePath)));
  }

  // 草稿没有活会话。按 Pi 的包解析再扫用户目录、工作区 .pi/skills 和 .agents/skills。
  return toResult("workspace", piSkillsToOutcome(await listPiSkills(params.workspace.workspacePath)));
}

function piSkillsToOutcome(skills: PiSkillView[]): SkillLoadOutcome {
  return {
    diagnostics: [],
    totalDiscovered: skills.length,
    skills: skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
      directory: skill.path,
      rootPath: skill.path,
      scope: skill.scope === "project" ? "project" : "user",
      source: skill.origin === "package" ? "plugin" : "zcode",
      safeToAutoLoad: true,
      frontmatterKeys: [],
      ...(skill.packageName ? { pluginName: skill.packageName } : {}),
    })),
  };
}

function toResult(
  authority: ZCodeSkillsReferenceCatalogResult["authority"],
  outcome: SkillLoadOutcome,
): ZCodeSkillsReferenceCatalogResult {
  return {
    authority,
    // 内置技能包（bundled-skills.ts）不进引用面板：它由内置命令（`/workflow`）加载，不是用户
    // 管理或引用的对象；协议的 scope 是封闭枚举，旧客户端严格校验，这里不为它扩枚举。
    skills: outcome.skills
      .filter((skill) => skill.source !== "bundled")
      .map(toReferenceCatalogEntry),
  };
}

function toReferenceCatalogEntry(skill: SkillMetadata): ZCodeSkillReferenceCatalogEntry {
  const scope =
    skill.source === "plugin" ? "plugin" : skill.scope === "project" ? "workspace" : "user";
  return {
    // `glm:` 是现有 UI provider 过滤契约；路径使同名不同来源仍有稳定行身份。
    id: `glm:${scope}:${skill.path}`,
    name: skill.name,
    description: skill.description,
    path: skill.path,
    scope,
    enabled: true,
    ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
  };
}
