import { describe, expect, it } from "vitest";
import { createTabStore } from "./tabStore.js";

function createStore() {
  return createTabStore(null);
}

function onlyWorkspaceTab(store: ReturnType<typeof createStore>) {
  const tab = store.getState().tabs.find((candidate) => candidate.kind === "workspace");
  if (!tab || tab.kind !== "workspace") {
    throw new Error("expected a workspace tab");
  }
  return tab;
}

describe("项目显示名", () => {
  it("renames a local project and clears back to the derived name", () => {
    const store = createStore();
    const tabId = store.getState().addTab("/srv/pay");
    store.getState().setWorkspaceDisplayName(tabId, "  支付服务  ");
    expect(onlyWorkspaceTab(store).displayName).toBe("支付服务");

    // 清空必须回到 undefined，派生名才会重新生效。
    store.getState().setWorkspaceDisplayName(tabId, "   ");
    expect(onlyWorkspaceTab(store).displayName).toBeUndefined();
  });

  it("restores the persisted name into the tab", () => {
    const store = createStore();
    store.getState().restoreTabs([{ workspacePath: "/root/app", displayName: "生产服务器" }], 0);
    expect(onlyWorkspaceTab(store).displayName).toBe("生产服务器");
  });

  it("does not let a stale restore snapshot overwrite a fresh rename", () => {
    const store = createStore();
    store.getState().restoreTabs(["/root/app"], 0);
    const tabId = onlyWorkspaceTab(store).id;
    store.getState().setWorkspaceDisplayName(tabId, "新名字");

    // 首帧后的补齐恢复拿的是启动时的旧快照，不能把用户刚改的名字盖回去。
    store.getState().completeTabRestore([{ workspacePath: "/root/app", displayName: "旧名字" }]);

    expect(onlyWorkspaceTab(store).displayName).toBe("新名字");
  });

  it("adopts the persisted name when the tab has none yet", () => {
    const store = createStore();
    store.getState().addTab("/root/app");
    store
      .getState()
      .completeTabRestore([{ workspacePath: "/root/app", displayName: "生产服务器" }]);

    expect(onlyWorkspaceTab(store).displayName).toBe("生产服务器");
  });
});
