import { describe, expect, it } from "vitest";
import type { NativeMcpServerRecord } from "@zcode/shared";
import {
  mcpProjectionMatchesWorkspace,
  mcpServersForProjectStatusProbe,
  projectMcpConfig,
  projectMcpUpsertPlan,
  selectProjectMcpRecords,
  toProjectMcpServers,
} from "./projectMcpRecords.js";

const projectServer: NativeMcpServerRecord = {
  source: "zcodeagentmcp",
  scope: "workspace",
  name: "local",
  config: { command: "echo" },
  enabled: true,
  projectPath: "/work/app",
  location: {
    source: "zcode",
    scope: "project",
    directoryPath: "/work/app/.pi",
    projectPath: "/work/app",
  },
};

describe("project MCP records", () => {
  it("keeps only this workspace's Pi mcp.json servers", () => {
    const selected = selectProjectMcpRecords([
      projectServer,
      {
        ...projectServer,
        name: "global",
        scope: "user",
        projectPath: undefined,
        location: undefined,
      },
      {
        ...projectServer,
        name: "agents",
        location: {
          ...projectServer.location!,
          source: "agents",
          directoryPath: "/work/app/.agents",
        },
      },
    ]);
    expect(selected.map((record) => record.name)).toEqual(["local"]);
    expect(toProjectMcpServers(selected)[0]?.scope).toBe("workspace");
  });

  it("writes a rename as upsert then delete, always with the project path", () => {
    const writes = projectMcpUpsertPlan({
      previousName: "local",
      nextName: "renamed",
      projectPath: "/work/app",
      config: projectMcpConfig({ command: "echo", enabled: true, enable: false }, false),
    });
    expect(writes.map((write) => [write.action, write.name, write.projectPath])).toEqual([
      ["upsert", "renamed", "/work/app"],
      ["delete", "local", "/work/app"],
    ]);
    expect(writes[0]?.config).toEqual({ command: "echo", enabled: false });
  });

  it("probes enabled user and project servers, not a project-only set", () => {
    const probe = mcpServersForProjectStatusProbe(
      [
        projectServer,
        {
          ...projectServer,
          name: "global",
          scope: "user",
          projectPath: undefined,
          config: { command: "global" },
          location: undefined,
        },
        { ...projectServer, name: "off", enabled: false },
        {
          ...projectServer,
          name: "other-project",
          projectPath: "/work/other",
          location: {
            ...projectServer.location!,
            directoryPath: "/work/other/.pi",
            projectPath: "/work/other",
          },
        },
      ],
      "/work/app",
    );
    expect(probe.map((server) => server.name)).toEqual(["local", "global"]);
  });

  it("does not treat another workspace's MCP projection as this one", () => {
    expect(
      mcpProjectionMatchesWorkspace(
        { projectPath: "/work/app", workspaceIdentity: "ssh:1" },
        { projectPath: "/work/app", workspaceIdentity: "ssh:1" },
      ),
    ).toBe(true);
    expect(
      mcpProjectionMatchesWorkspace({ projectPath: "/work/other" }, { projectPath: "/work/app" }),
    ).toBe(false);
    expect(mcpProjectionMatchesWorkspace({ projectPath: "" }, { projectPath: "" })).toBe(false);
  });
});
