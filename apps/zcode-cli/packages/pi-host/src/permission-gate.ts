export type ToolPermissionDecision = "allow" | "deny";

export type ToolPermissionCheck = (input: {
  toolName: string;
  args: unknown;
}) => Promise<ToolPermissionDecision>;

export async function gateTool(
  check: ToolPermissionCheck | undefined,
  toolName: string,
  args: unknown,
): Promise<void> {
  if (!check) return;
  const decision = await check({ toolName, args });
  if (decision === "deny") throw new Error(`permission denied: ${toolName}`);
}
