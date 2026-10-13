import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStartupWindowBootstrap } from "./startupWorkspace.js";

describe("startup agent warmup", () => {
  it("warms only the workspace being restored, not older recent projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-warmup-"));
    const settingsFile = join(root, "settings.json");
    await writeFile(
      settingsFile,
      JSON.stringify({
        recentProjects: [
          "D:/Study/Code/Node/pi-processes",
          "D:/Study/Code/Github/lens",
          "D:/Study/Code/Github/ZCode",
        ],
        lastActiveTabIndex: 0,
        lastWorkspaceSession: [
          { kind: "local", workspacePath: "D:/Study/Code/Github/ZCode", workspacePurpose: "project" },
        ],
      }),
    );

    const bootstrap = await resolveStartupWindowBootstrap({
      settingsFile,
      conversationWorkspaceDir: join(root, "conversations"),
    });

    expect(bootstrap.agentWarmupTargets).toEqual([
      { workspacePath: "D:/Study/Code/Github/ZCode" },
    ]);
  });
});
