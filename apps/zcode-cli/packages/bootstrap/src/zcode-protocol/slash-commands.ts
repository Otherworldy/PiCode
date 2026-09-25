import { listPiSlashCommands, type PiSlashCommandView } from "@zcode/pi-host";
import type { ZCodeSlashCommand } from "@zcode/shared";
import type { ListZCodeCustomCommandsOptions } from "../custom-commands.js";
import { APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS } from "../slash-command-surface.js";

export interface ListProtocolSlashCommandsOptions extends ListZCodeCustomCommandsOptions {
  /**
   * 动态工作流灰度门。斜杠目录已改跟 Pi，不再据此增删命令。
   * 保留字段，避免旧调用方传参变成类型错误。
   */
  dynamicWorkflowEnabled?: boolean;
  /** 活会话已经加载的 Pi 命令。没有会话时按提示词目录现扫。 */
  piCommands?: readonly PiSlashCommandView[];
}

export async function listProtocolSlashCommands(
  options: ListProtocolSlashCommandsOptions = {},
): Promise<ZCodeSlashCommand[]> {
  const discovered =
    options.piCommands ??
    (await listPiSlashCommands(options.workingDirectory ?? process.cwd()));
  const commands = discovered.map(toProtocolSlashCommand);
  for (const command of APP_PROTOCOL_APP_ONLY_BUILTIN_SLASH_COMMANDS) {
    if (!commands.some((existing) => existing.name === command.name)) commands.push(command);
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

function toProtocolSlashCommand(command: PiSlashCommandView): ZCodeSlashCommand {
  return {
    name: command.name,
    description: command.description,
    inputHint: command.inputHint,
    source: command.source,
  };
}
