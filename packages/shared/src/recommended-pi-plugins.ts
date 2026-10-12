/** 设置页可一键安装的 Pi 包。宿主已经按这些包的命令、事件或工具名接上界面。 */
export const recommendedPiPlugins = [
  {
    source: "npm:@plannotator/pi-extension",
    needles: ["@plannotator/pi-extension"],
  },
  {
    source: "https://github.com/Otherworldy/pi-processes-bash",
    needles: ["otherworldy/pi-processes-bash", "pi-processes-bash", "pi-processes"],
  },
  {
    source: "git:github.com/Otherworldy/pi-ask-me",
    needles: ["pi-ask-me", "otherworldy/pi-ask-me"],
  },
] as const;

export const recommendedPiPluginSources = [
  recommendedPiPlugins[0].source,
  recommendedPiPlugins[1].source,
  recommendedPiPlugins[2].source,
] as const;

export type RecommendedPiPluginSource = (typeof recommendedPiPluginSources)[number];

export function isRecommendedPiPluginSource(source: string): source is RecommendedPiPluginSource {
  return recommendedPiPluginSources.some((item) => item === source);
}

export function recommendedPiPluginSourceMatches(
  configuredSource: string,
  source: RecommendedPiPluginSource,
): boolean {
  const item = recommendedPiPlugins.find((entry) => entry.source === source);
  if (!item) return false;
  const hay = configuredSource.toLowerCase();
  return item.needles.some((needle) => hay.includes(needle));
}

export function isRecommendedPiPluginInstalled(
  plugins: readonly {
    id: string;
    detail: string;
    name: string;
    scope: string;
    kind: string;
  }[],
  source: RecommendedPiPluginSource,
  scope: "user" | "project",
): boolean {
  return plugins.some((plugin) => {
    if (plugin.kind !== "package" || plugin.scope !== scope) return false;
    return recommendedPiPluginSourceMatches(
      `${plugin.id}\n${plugin.detail}\n${plugin.name}`,
      source,
    );
  });
}
