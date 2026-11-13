import type { ResourceLoader } from "@earendil-works/pi-coding-agent";
import { applyZcodePluginPlan, type ZcodePluginSessionPlan } from "./pi-plugins.js";
import { piCoding } from "./pi-sdk.js";

type LoaderOptions = ConstructorParameters<ReturnType<typeof piCoding>["DefaultResourceLoader"]>[0];
type PluginExtras = {
  loader: Pick<
    LoaderOptions,
    "additionalSkillPaths" | "additionalExtensionPaths" | "additionalPromptTemplatePaths"
  >;
  plan?: ZcodePluginSessionPlan;
};

/** 复用 SDK loader 的重载语义；适配器持有的路径数组和开关在每轮加载前刷新。 */
export function createSessionResourceLoader(
  options: LoaderOptions,
  loadExtras: () => Promise<PluginExtras | undefined>,
): ResourceLoader {
  const paths = {
    additionalSkillPaths: [...(options.additionalSkillPaths ?? [])],
    additionalExtensionPaths: [...(options.additionalExtensionPaths ?? [])],
    additionalPromptTemplatePaths: [...(options.additionalPromptTemplatePaths ?? [])],
  };
  // SDK 仅在同一 loader 再次 reload 时清扩展缓存；新建实例会让同路径更新命中旧 factory。
  const delegate = new (piCoding().DefaultResourceLoader)({ ...options, ...paths });
  let plan: ZcodePluginSessionPlan | undefined;
  return {
    getExtensions: () => delegate.getExtensions(),
    getSkills: () => delegate.getSkills(),
    getPrompts: () => delegate.getPrompts(),
    getThemes: () => delegate.getThemes(),
    getAgentsFiles: () => delegate.getAgentsFiles(),
    getSystemPrompt: () => delegate.getSystemPrompt(),
    getSystemPromptSource: () => delegate.getSystemPromptSource(),
    getAppendSystemPrompt: () => delegate.getAppendSystemPrompt(),
    getAppendSystemPromptSources: () => delegate.getAppendSystemPromptSources(),
    extendResources(paths) {
      delegate.extendResources(paths);
      if (plan) applyZcodePluginPlan(delegate, plan);
    },
    async reload(reloadOptions) {
      const extras = await loadExtras();
      for (const kind of [
        "additionalSkillPaths",
        "additionalExtensionPaths",
        "additionalPromptTemplatePaths",
      ] as const) {
        paths[kind].splice(0, paths[kind].length, ...(extras?.loader[kind] ?? options[kind] ?? []));
      }
      await delegate.reload(reloadOptions);
      // 加载失败时保留已加载资源对应的计划，不能让新开关过滤上一轮资源。
      plan = extras?.plan;
      if (plan) applyZcodePluginPlan(delegate, plan);
    },
  };
}
