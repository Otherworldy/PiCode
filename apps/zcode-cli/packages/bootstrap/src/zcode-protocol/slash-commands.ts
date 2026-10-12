import {
  isPlannotatorPiExtension,
  listPiPlugins,
  listPiSlashCommands,
  type PiSlashCommandView,
} from "@zcode/pi-host";
import type { ZCodeSlashCommand } from "@zcode/shared";
import type { ListZCodeCustomCommandsOptions } from "../custom-commands.js";
import { APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS } from "../slash-command-surface.js";

export interface ListProtocolSlashCommandsOptions extends ListZCodeCustomCommandsOptions {
  /**
   * 动态工作流灰度门。斜杠目录已改跟 Pi，不再据此增删命令。
   * 保留字段，避免旧调用方传参变成类型错误。
   */
  dynamicWorkflowEnabled?: boolean;
  /**
   * 活会话已经加载的 Pi 命令。扩展命令只能从这里来。
   * 提示词文件不冻结在会话创建时：即使传了这份快照，仍会再扫一次目录，把保存后新出现的文件补进菜单。
   */
  piCommands?: readonly PiSlashCommandView[];
}

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ZCodeSlashCommand[]> {
  const cwd = options.workingDirectory ?? process.cwd();
  const scanned = await listPiSlashCommands(cwd);
  const discovered = options.piCommands
    ? mergeScannedPromptTemplates(options.piCommands, scanned)
    : scanned;
  const commands = discovered.map(toProtocolSlashCommand);
  for (const command of APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS) {
    if (!commands.some((existing) => existing.name === command.name)) commands.push(command);
  }
  // 没有活会话时扩展命令还没注册。已启用的 Plannotator 仍要让计划开关出现。
  // 已打开的会话只认它自己注册的命令；旧会话要新建后才加载插件。
  if (!options.piCommands && !commands.some((command) => command.name === "plannotator-plan-mode")) {
    const plugins = await listPiPlugins(options.workingDirectory ?? process.cwd()).catch(() => []);
    if (plugins.some(isPlannotatorPiExtension)) {
      commands.push({
        name: "plannotator-plan-mode",
        description: "Toggle plannotator planning mode",
        source: "extension",
      });
    }
  }
  return commands;
}

export function livePiSlashCommands(
  sessions: Iterable<{ parentSessionId?: string; app: object; workspace: { workspacePath: string } }>,
  workspacePath: string,
): { piCommands: PiSlashCommandView[] } | undefined {
  let fallback: PiSlashCommandView[] | undefined;
  for (const record of sessions) {
    if (record.workspace.workspacePath !== workspacePath) continue;
    const commands = piSlashCommandsFromApp(record.app);
    if (!commands) continue;
    if (!record.parentSessionId) return { piCommands: commands };
    fallback ??= commands;
  }
  return fallback ? { piCommands: fallback } : undefined;
}

export function piSlashCommandsFromApp(app: object): PiSlashCommandView[] | undefined {
  const list = (app as { piHosted?: { listSlashCommands?: () => PiSlashCommandView[] } }).piHosted
    ?.listSlashCommands;
  return list ? list() : undefined;
}

/** 活会话的快照留着扩展命令和包模板。磁盘上新建的提示词文件按名字补进去。 */
function mergeScannedPromptTemplates(
  live: readonly PiSlashCommandView[],
  scanned: readonly PiSlashCommandView[],
): PiSlashCommandView[] {
  const names = new Set(live.map((command) => command.name));
  const added = scanned.filter((command) => command.source === "custom" && !names.has(command.name));
  return [...live, ...added];
}

function toProtocolSlashCommand(command: PiSlashCommandView): ZCodeSlashCommand {
  return {
    name: command.name,
    description: command.description,
    inputHint: command.inputHint,
    source: command.source,
  };
}
