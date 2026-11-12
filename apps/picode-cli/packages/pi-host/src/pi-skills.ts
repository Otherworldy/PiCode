import { dirname } from "node:path";
import { disabledPiPackageIds, zcodePluginSourceId } from "./pi-plugins.js";
import { ensurePiSdk, piCoding } from "./pi-sdk.js";
import type { PiSkillView } from "./types.js";

type PiLoadedSkill = {
  name: string;
  description: string;
  filePath: string;
  sourceInfo?: { scope?: string; origin?: string; source?: string };
};

/** Pi `loadSkills` 的结果。同名冲突时 Pi 保留先加入的那份。 */
export function toPiSkillView(skill: PiLoadedSkill): PiSkillView {
  const scope = skill.sourceInfo?.scope;
  return {
    name: skill.name,
    description: skill.description,
    path: skill.filePath,
    scope: scope === "project" || scope === "temporary" ? scope : "user",
    origin: skill.sourceInfo?.origin === "package" ? "package" : "top-level",
    ...(skill.sourceInfo?.origin === "package" && skill.sourceInfo.source
      ? { packageName: skill.sourceInfo.source }
      : {}),
  };
}

/**
 * 和 Pi `DefaultResourceLoader` 同一条发现，但不加载扩展。
 * 用户 `~/.pi/agent/skills`、`~/.agents/skills`、工作区 `.pi/skills`、
 * 沿 git 根向上的 `.agents/skills`，以及 settings 里启用的包技能。
 */
export async function listPiSkills(
  cwd: string,
  agentDir?: string,
  switchRoot?: string,
): Promise<PiSkillView[]> {
  await ensurePiSdk();
  const coding = piCoding();
  const dir = agentDir ?? coding.getAgentDir();
  const settingsManager = coding.SettingsManager.create(cwd, dir);
  const resolved = await new coding.DefaultPackageManager({
    cwd,
    agentDir: dir,
    settingsManager,
  }).resolve();
  const enabled = resolved.skills.filter((entry) => entry.enabled);
  const metadataByPath = new Map(enabled.map((entry) => [entry.path, entry.metadata]));
  const disabled = await disabledPiPackageIds(cwd, dir, switchRoot);
  const loaded = coding.loadSkills({
    cwd,
    agentDir: dir,
    skillPaths: enabled.map((entry) => entry.path),
    includeDefaults: false,
  });
  const views: PiSkillView[] = [];
  for (const skill of loaded.skills) {
    const sourceInfo = metadataFor(metadataByPath, skill.filePath) ?? skill.sourceInfo;
    const id = packageSwitchId(sourceInfo, skill.filePath);
    if (id && disabled.has(id)) continue;
    views.push(toPiSkillView({ ...skill, sourceInfo }));
  }
  return views;
}

function packageSwitchId(
  info: { origin?: string; source?: string; scope?: string; baseDir?: string } | undefined,
  filePath: string,
): string | undefined {
  if (!info?.origin || !info.source || !info.scope) return undefined;
  return zcodePluginSourceId(
    {
      origin: info.origin,
      source: info.source,
      scope: info.scope,
      ...(info.baseDir ? { baseDir: info.baseDir } : {}),
    },
    filePath,
  );
}

function metadataFor(
  metadataByPath: Map<string, { scope?: string; origin?: string; source?: string }>,
  filePath: string,
) {
  let current = filePath;
  while (true) {
    const found = metadataByPath.get(current);
    if (found) return found;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
