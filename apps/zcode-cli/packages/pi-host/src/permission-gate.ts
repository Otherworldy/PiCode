import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export type ToolPermissionDecision = "allow" | "deny";

export type ToolPermissionCheck = (input: {
  toolName: string;
  args: unknown;
}) => Promise<ToolPermissionDecision>;

/** 不替换 Pi 的工具实现，只在执行前拦住。 */
export function createPermissionExtension(check: ToolPermissionCheck | undefined): InlineExtension {
  return {
    name: "picode-permissions",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event) => {
        try {
          await gateTool(check, event.toolName, event.input);
        } catch (error) {
          return {
            block: true,
            reason: error instanceof Error ? error.message : String(error),
          };
        }
        return undefined;
      });
    },
  };
}

export async function gateTool(
  check: ToolPermissionCheck | undefined,
  toolName: string,
  args: unknown,
): Promise<void> {
  if (!check) return;
  const decision = await check({ toolName, args });
  if (decision === "deny") throw new Error(`permission denied: ${toolName}`);
}
