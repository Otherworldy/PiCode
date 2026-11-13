import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ZCodeIntlProvider, useZCodeIntl } from "../../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { TabStoreProvider, useTabStoreApi } from "../../src/store/TabStoreProvider.js";
import { useRemoteWorkspaceSessionStore } from "../../src/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "../../src/store/picodeSessionStore.js";
import { useWorkspaceSessionReload } from "../../src/app-shell/useWorkspaceSessionReload.js";
import { useWorkspaceShellZCodeState } from "../../src/app-shell/useWorkspaceShellPiCodeState.js";
import { useSkills } from "../../src/hooks/useSkills.js";
import { usePluginReferenceCatalog } from "../../src/hooks/usePluginReferenceCatalog.js";
import { useAgentToolCatalog } from "../../src/hooks/useAgentToolCatalog.js";
import { SessionReloadMenuItem } from "../../src/WorkspaceHeaderSections/SessionReloadMenuItem.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
} from "../../src/components/ui/dropdown-menu.js";
import { V4_WIRE_PROTOCOL_VERSION } from "@picode/shared/picode-protocol-v4";

const query = new URLSearchParams(location.search);
localStorage.setItem("zcode-locale-preference", query.get("locale") ?? "en-US");
const workspacePath = "/same/path";
const workspaceIdentity = "remote-workspace";
const remoteSessionId = "attachment";
const clientMode = query.get("mode") ?? "desktop-continuous";
const state = {
  commands: [] as any[],
  handshakes: [] as any[],
  restarts: [] as any[],
  skillQueries: 0,
  pluginQueries: 0,
  toolQueries: 0,
  localCommands: 0,
  resolve: (_ack: any) => {},
  releaseOld: () => {},
  reloadTwice: () => {},
  switchSession: (_id: string | null) => {},
  reloadStaleSession: async (_id: string) => {},
  setBusy: (_busy: boolean) => {},
};
(window as any).reloadScenario = state;
let releaseSkill: (result: any) => void;
let releasePlugin: (result: any) => void;
state.releaseOld = () => {
  releaseSkill?.({ authority: "session", skills: [{ name: "stale-skill" }] });
  releasePlugin?.({ authority: "session", plugins: [{ name: "stale-plugin" }] });
};
const agent = {
  helloConversationV4: async () => ({
    kind: "hello",
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: "connection",
    clientMode,
    deliveryProfile: clientMode === "desktop-continuous" ? "continuous" : "replayable",
    serverTime: 1,
    capabilities: {
      nativeDialogs: false,
      localTerminal: false,
      binaryFrames: false,
      compression: "none",
    },
    auth: {},
  }),
  initializeConversationV4: async (hello: any) => {
    state.handshakes.push(hello);
  },
  sendConversationCommandV4: (command: any) => {
    state.commands.push(command);
    return new Promise((resolve) => {
      state.resolve = (ack) =>
        resolve({ commandId: command.envelope.commandId, revisionAtDecision: 0, ...ack });
    });
  },
  onAgentRuntimeRestarted: () => ({ dispose() {} }),
  getSkillReferenceCatalog: async () => {
    state.skillQueries += 1;
    if (state.skillQueries === 1)
      return new Promise((resolve) => {
        releaseSkill = resolve;
      });
    return { authority: "session", skills: [{ name: "fresh-skill" }] };
  },
  getAgentToolCatalog: async () => {
    state.toolQueries += 1;
    return { tools: [{ name: `tool-${state.toolQueries}`, source: "extension" }] };
  },
};
const remoteServices: any = {
  zcodeAgentService: agent,
  pluginManagementService: {
    getPluginReferenceCatalog: async () => {
      state.pluginQueries += 1;
      if (state.pluginQueries === 1)
        return new Promise((resolve) => {
          releasePlugin = resolve;
        });
      return { authority: "session", plugins: [{ name: "fresh-plugin" }] };
    },
  },
  zcodeTaskService: {
    restartWorkspaceProcess: async (params: any) => {
      state.restarts.push(params);
    },
  },
  zcodeSessionService: {
    readWorkspacePresentation: async () => ({ mode: "build", slashCommands: [] }),
  },
};
const baseServices: any = {
  zcodeAgentService: {
    ...agent,
    sendConversationCommandV4: async () => {
      state.localCommands += 1;
      throw new Error("wrong host");
    },
  },
};
const remoteStore = useRemoteWorkspaceSessionStore.getState();
remoteStore.registerBaseServices(baseServices);
remoteStore.registerSession({ sessionId: remoteSessionId, services: remoteServices });
remoteStore.bindWorkspaceIdentity(workspaceIdentity, remoteSessionId);
const sessionStore = useZCodeSessionStore.getState();
sessionStore.setActiveTaskId(workspacePath, "current-session", workspaceIdentity);
// 同工作区的其他会话在忙，不能因此禁用当前会话重载。
sessionStore.setTaskRuntimeState(
  workspacePath,
  "sibling-session",
  "streaming",
  null,
  workspaceIdentity,
);

function Scenario() {
  const tabStore = useTabStoreApi();
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState("unsent draft");
  const sessionId = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).activeTaskId,
  );
  const slashCommands = useZCodeSessionStore(
    (store) => store.getWorkspaceState(workspacePath, workspaceIdentity).slashCommands,
  );
  const { reloadSessionDisabled } = useWorkspaceShellZCodeState(workspacePath, workspaceIdentity);
  const { reloadSessionPending, handleReloadSession } = useWorkspaceSessionReload({
    intl,
    workspaceAbsPath: workspacePath,
    reloadSessionDisabled,
  });
  const skills = useSkills({
    workspacePath,
    workspaceIdentity,
    sessionId,
    enabled: Boolean(sessionId),
    preferredRemoteSessionId: remoteSessionId,
  });
  const plugins = usePluginReferenceCatalog(
    workspacePath,
    workspaceIdentity,
    sessionId,
    Boolean(sessionId),
    { preferredRemoteSessionId: remoteSessionId, dedupeSessionRequest: true },
  );
  const tools = useAgentToolCatalog({ workspacePath, workspaceIdentity, enabled: true });
  useEffect(() => {
    tabStore.getState().addTab(workspacePath, { workspaceIdentity, remoteSessionId });
  }, [tabStore]);
  state.reloadTwice = () => {
    if (!sessionId) return;
    void handleReloadSession(sessionId);
    void handleReloadSession(sessionId);
  };
  state.switchSession = (id) => sessionStore.setActiveTaskId(workspacePath, id, workspaceIdentity);
  state.reloadStaleSession = async (id) => {
    await handleReloadSession(id);
  };
  state.setBusy = (busy) =>
    sessionStore.setTaskRuntimeState(
      workspacePath,
      "current-session",
      busy ? "streaming" : "idle",
      null,
      workspaceIdentity,
    );
  return (
    <>
      <input aria-label="Draft" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <output data-testid="session">{sessionId}</output>
      <output data-testid="pending">{String(reloadSessionPending)}</output>
      <output data-testid="catalogs">
        {skills.skills.map((s) => s.name).join()}|{plugins.entries.map((p) => p.name).join()}|
        {tools.tools.map((t) => t.name).join()}
      </output>
      <output data-testid="commands">{slashCommands.map((c) => c.name).join()}</output>
      <DropdownMenu>
        <DropdownMenuTrigger>Session menu</DropdownMenuTrigger>
        <DropdownMenuContent>
          <SessionReloadMenuItem
            sessionId={sessionId}
            readOnly={false}
            busy={reloadSessionDisabled}
            pending={reloadSessionPending}
            onReload={(id) => handleReloadSession(id)}
          />
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={baseServices}>
    <TabStoreProvider>
      <ZCodeIntlProvider>
        <Scenario />
      </ZCodeIntlProvider>
    </TabStoreProvider>
  </ServiceProvider>,
);
