import { describe, expect, it } from "vitest";
import type { RemoteWorkspaceSessionEntry } from "@zcode/shared";
import {
  buildPersistedWorkspaceSessionEntries,
  buildRemoteWorkspaceSessionEntryMap,
} from "./remoteWorkspaceHistory.js";
import {
  normalizeWorkspaceDisplayName,
  resolveWorkspaceDisplayLabel,
} from "./workspaceDisplayName.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

const sshTarget = { kind: "ssh", host: "203.0.113.10", username: "root" } as const;

describe("resolveWorkspaceDisplayLabel", () => {
  it("prefers the custom name over the ssh host", () => {
    expect(resolveWorkspaceDisplayLabel("repo", sshTarget, "生产服务器")).toBe("生产服务器");
  });

  it("prefers the custom name over the local folder name", () => {
    expect(resolveWorkspaceDisplayLabel("repo", undefined, "支付服务")).toBe("支付服务");
  });

  it("falls back to the derived name when the custom name is blank", () => {
    expect(resolveWorkspaceDisplayLabel("repo", sshTarget, "   ")).toBe("203.0.113.10");
    expect(resolveWorkspaceDisplayLabel("repo", sshTarget, "")).toBe("203.0.113.10");
    expect(resolveWorkspaceDisplayLabel("repo", undefined, "")).toBe("repo");
  });
});

describe("normalizeWorkspaceDisplayName", () => {
  it("treats blank input as no custom name", () => {
    // 清空输入必须回到 undefined，否则侧栏会出现空标题。
    expect(normalizeWorkspaceDisplayName("  \n ")).toBeUndefined();
    expect(normalizeWorkspaceDisplayName(undefined)).toBeUndefined();
  });

  it("collapses newlines so a pasted name cannot break the sidebar row", () => {
    expect(normalizeWorkspaceDisplayName(" 支付\n服务 ")).toBe("支付 服务");
  });

  it("caps the length at the persisted schema limit", () => {
    expect(normalizeWorkspaceDisplayName("x".repeat(120))).toHaveLength(80);
  });
});

function buildTab(overrides: Partial<WorkspaceTabState>): WorkspaceTabState {
  return {
    id: "tab-1",
    kind: "workspace",
    workspacePath: "/root/app",
    label: "app",
    ...overrides,
  } as WorkspaceTabState;
}

const remoteEntry: RemoteWorkspaceSessionEntry = {
  kind: "remote",
  workspacePath: "/root/app",
  workspaceIdentity: "ssh-dev",
  target: { kind: "ssh", host: "203.0.113.10", username: "root" },
  lastOpenedAt: 1,
  lastConnectionStatus: "connected",
};

describe("项目名持久化", () => {
  it("writes the tab's custom name into the remote session snapshot", () => {
    const entries = buildPersistedWorkspaceSessionEntries(
      [
        buildTab({
          workspaceIdentity: "ssh-dev",
          remoteTarget: sshTarget,
          displayName: "生产服务器",
        }),
      ],
      buildRemoteWorkspaceSessionEntryMap([remoteEntry]),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "remote", displayName: "生产服务器" });
  });

  it("drops a stale name from the snapshot when the tab cleared it", () => {
    // 清空改名后 tab 没有 displayName；快照里上一轮写进去的旧名字必须被剥掉，
    // 否则下一次启动又会从 setting.json 里把旧名字恢复出来。
    const entries = buildPersistedWorkspaceSessionEntries(
      [buildTab({ workspaceIdentity: "ssh-dev", remoteTarget: sshTarget })],
      buildRemoteWorkspaceSessionEntryMap([{ ...remoteEntry, displayName: "旧名字" }]),
    );

    expect(entries[0]).toMatchObject({ kind: "remote" });
    expect(entries[0]).not.toHaveProperty("displayName");
  });

  it("keeps a remote snapshot without a custom name untouched", () => {
    const entries = buildPersistedWorkspaceSessionEntries(
      [buildTab({ workspaceIdentity: "ssh-dev", remoteTarget: sshTarget })],
      buildRemoteWorkspaceSessionEntryMap([remoteEntry]),
    );

    expect(entries[0]).toMatchObject({ kind: "remote" });
    expect(entries[0]).not.toHaveProperty("displayName");
  });

  it("persists local project renames too", () => {
    const entries = buildPersistedWorkspaceSessionEntries(
      [buildTab({ workspacePath: "/srv/pay", label: "pay", displayName: "支付服务" })],
      new Map(),
    );

    expect(entries[0]).toMatchObject({
      kind: "local",
      workspacePath: "/srv/pay",
      displayName: "支付服务",
    });
  });
});
