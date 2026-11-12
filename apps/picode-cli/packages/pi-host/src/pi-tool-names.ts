/** Pi 内置工具名。子会话白名单、工具清单和扩展反查共用这一份。 */
export const PI_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "powershell",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;

export const PI_BUILTIN_NAME_SET: ReadonlySet<string> = new Set(PI_BUILTIN_TOOL_NAMES);

/** 本机 Pi 内置工具名。powershell 在非 Windows 上注册了也跑不起来，不给声明。 */
export function piLocalToolNames(): string[] {
  return PI_BUILTIN_TOOL_NAMES.filter(
    (name) => name !== "powershell" || process.platform === "win32",
  );
}
