import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * 上游插件在 Pi 宿主上默认不注册 `plannotator` 工具（`AGENT_TOOL_DEFAULTS.pi = false`，
 * 因为 Pi 每次请求都带全部工具定义）。PiCode 的 UI 设计模式却全靠它打开审查页，
 * 没显式关掉就替用户打开：`PLANNOTATOR_AGENT_TOOL` 的优先级高于 `config.agentTool`。
 *
 * 插件每个会话读一次这两项，所以必须在会话建出来之前调用。返回是否真的改了环境。
 */
export function ensurePlannotatorAgentToolEnabled(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): boolean {
  // 用户自己设过（不管真假）都算数。
  if (env.PLANNOTATOR_AGENT_TOOL !== undefined) return false;
  if (configSaysAgentToolOff(env, home)) return false;
  env.PLANNOTATOR_AGENT_TOOL = "1";
  return true;
}

/** 配置里显式关掉是用户自己的选择，不覆盖。只有布尔 false 与 "false" / "0" 算关。 */
function configSaysAgentToolOff(env: NodeJS.ProcessEnv, home: string): boolean {
  try {
    const file = join(plannotatorDataDir(env, home), "config.json");
    if (!existsSync(file)) return false;
    // 记事本的 UTF-8 BOM 不属于 JSON，与插件自己的读法一致。
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as {
      agentTool?: unknown;
    };
    const value = parsed?.agentTool;
    if (value === false) return true;
    if (typeof value !== "string") return false;
    const text = value.trim().toLowerCase();
    return text === "false" || text === "0";
  } catch {
    // 读不出来就当没关：宁可多给一个工具，也不要让 UI 设计模式打不开审查页。
    return false;
  }
}

/** 与插件 `getPlannotatorDataDir` 同一套解析：`PLANNOTATOR_DATA_DIR` → `~/.plannotator` → XDG。 */
function plannotatorDataDir(env: NodeJS.ProcessEnv, home: string): string {
  const configured = env.PLANNOTATOR_DATA_DIR?.trim();
  if (configured) {
    if (configured === "~") return home;
    if (configured.startsWith("~/") || configured.startsWith("~\\")) {
      return join(home, configured.slice(2));
    }
    return resolve(configured);
  }
  const legacy = join(home, ".plannotator");
  if (existsSync(legacy)) return legacy;
  const xdg = env.XDG_DATA_HOME?.trim();
  return xdg && isAbsolute(xdg) ? join(xdg, "plannotator") : legacy;
}
