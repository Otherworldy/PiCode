import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from "react";
import type {
  CommandAck,
  CommandEnvelope,
  V4AttachmentPutParams,
  V4AttachmentPutResult,
  V4ConversationFileChangesParams,
  V4ConversationFileChangesResult,
  V4ConversationFileRewindPreviewParams,
  V4ConversationFileRewindPreviewResult,
} from "@picode/shared/picode-protocol-v4";
import type { IServiceAccessor } from "@picode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import type { ConversationAttachmentReadParams, ConversationTransport } from "@/v4/transport.js";
import type { PaneWorkspaceScope } from "@/v4/paneLayoutStore.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import { acquireWorkspaceConnection } from "@/v4/workspaceConnectionRegistry.js";
import type { AttachmentUploadOptions } from "@/v4/attachmentUploadTransaction.js";

export interface V4ConversationContextValue {
  layer: SessionDataLayer;
  sendCommand(envelope: CommandEnvelope): Promise<CommandAck>;
  fileChanges(params: V4ConversationFileChangesParams): Promise<V4ConversationFileChangesResult>;
  fileRewindPreview(
    params: V4ConversationFileRewindPreviewParams,
  ): Promise<V4ConversationFileRewindPreviewResult>;
  /** UI 高层 put 语义；transport 内部只走 begin/chunk/commit/abort。 */
  attachmentPut(
    params: V4AttachmentPutParams,
    options?: AttachmentUploadOptions,
  ): Promise<V4AttachmentPutResult>;
  attachmentRead(
    params: ConversationAttachmentReadParams,
  ): ReturnType<ConversationTransport["attachmentRead"]>;
  attachmentReadRange(
    params: Parameters<ConversationTransport["attachmentReadRange"]>[0],
  ): ReturnType<ConversationTransport["attachmentReadRange"]>;
  onRuntimeRestart(listener: () => void): () => void;
  /**
   * 承载 transport 暴露 runtime 存活态时才存在（见 ConversationTransport.onRuntimeLifecycle）。
   * unavailable 在 workspace-dispose 当场到达，是草稿预热重建唯一可依赖的换代信号。
   */
  onRuntimeLifecycle?(listener: (state: "available" | "unavailable") => void): () => void;
}

// 导出 context 本体：静态回放视图用静态 transport 自己
// 装配 value 后直接 Provider 注入，不经 V4ConversationProvider 的 workspace 解析链路。
export const V4ConversationContext = createContext<V4ConversationContextValue | null>(null);

interface V4ConversationProviderProps {
  workspacePath: string;
  workspaceIdentity?: string;
  children: ReactNode;
}

function ReadyV4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
  services,
  remoteSessionId,
}: V4ConversationProviderProps & {
  services: IServiceAccessor;
  remoteSessionId: string | null;
}) {
  const { zcodeAgentService } = services;
  const platform = usePlatform();
  const bundle = useMemo(() => {
    const transport = createAgentConversationTransport(zcodeAgentService, {
      workspacePath,
      workspaceIdentity,
      // 主 workspace resolver 已识别远端 endpoint，但这里曾丢弃
      // remoteSessionId，导致远端绝对路径被交给本机 zcode-media。仅本地 endpoint 注入转换器。
      ...(remoteSessionId === null && platform.createLocalMediaPreviewUrl
        ? { createLocalMediaPreviewUrl: platform.createLocalMediaPreviewUrl }
        : {}),
    });
    const layer = new SessionDataLayer({ transport });
    return {
      layer,
      sendCommand: (envelope: CommandEnvelope) => transport.sendCommand(envelope),
      fileChanges: (params: V4ConversationFileChangesParams) => transport.fileChanges(params),
      fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
        transport.fileRewindPreview(params),
      attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
        transport.attachmentPut(params, options),
      attachmentRead: (params) => transport.attachmentRead(params),
      attachmentReadRange: (params) => transport.attachmentReadRange(params),
      onRuntimeRestart: (listener: () => void) => transport.onRuntimeRestart(listener),
      ...(transport.onRuntimeLifecycle
        ? {
            onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
              transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
          }
        : {}),
    } satisfies V4ConversationContextValue;
  }, [
    platform.createLocalMediaPreviewUrl,
    remoteSessionId,
    workspacePath,
    workspaceIdentity,
    zcodeAgentService,
  ]);

  useEffect(() => {
    return () => {
      bundle.layer.dispose();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <V4ConversationContext.Provider value={bundle}>{children}</V4ConversationContext.Provider>
    </ServiceProvider>
  );
}

/** 每个 workspace 一条 host 连接 + 一个 SessionDataLayer。 */
export function V4ConversationProvider({
  workspacePath,
  workspaceIdentity,
  children,
}: V4ConversationProviderProps) {
  const resolution = useWorkspaceServicesResolution(workspacePath, undefined, workspaceIdentity);
  if (!resolution.rpcReady) {
    return null;
  }

  return (
    <ReadyV4ConversationProvider
      workspacePath={workspacePath}
      workspaceIdentity={workspaceIdentity}
      services={resolution.services}
      remoteSessionId={resolution.remoteSessionId}
    >
      {children}
    </ReadyV4ConversationProvider>
  );
}

export function useV4Conversation(): V4ConversationContextValue {
  const ctx = useContext(V4ConversationContext);
  if (!ctx) {
    throw new Error("useV4Conversation 必须在 V4ConversationProvider 内使用");
  }
  return ctx;
}

/**
 * 有没有会话上下文可用。给那些**可以**在没有会话的宿主里渲染的组件（静态渲染、回放、
 * 转录里的完成卡）决定要不要挂上取数的那一层——挂了就得有上下文，没有就画冷态。
 */
export function useHasV4Conversation(): boolean {
  return useContext(V4ConversationContext) !== null;
}

interface V4PaneConversationProviderProps {
  /** pane 绑定的 primary workspace（连接路由键）。 */
  scope: PaneWorkspaceScope;
  children: ReactNode;
}

/**
 * per-pane 数据面：连接从 workspaceConnectionRegistry 租用
 * （同 endpoint+workspaceKey 的 pane 共享一条 transport + SessionDataLayer，
 * refCount + 30s keep-warm），并把 pane 自己的 services 注入子树——附件上传、
 * sessions-index 守卫等 hook 用 pane 的 accessor，不误用 shell 当前 workspace 的。
 *
 * 远程目标在 session store 尚未注册真实 services 时保持 remote-waiting，不挂载子数据层，
 * 因而不会拿断连代理创建连接或发起订阅；同时绝不回落 base services，也不为 pane
 * 另起独立 runtime（远控保护约束）。重连 ready 后 services 换新引用 → 注册表保持
 * 原 layer/transport 身份，并在 commit 阶段单向激活最新 proxy。
 */
export function V4PaneConversationProvider({ scope, children }: V4PaneConversationProviderProps) {
  const targetResolution = useWorkspaceServicesResolution(
    scope.workspacePath,
    scope.remoteSessionId ?? null,
    scope.workspaceIdentity ?? null,
  );
  const resolvedScope = useMemo<PaneWorkspaceScope>(
    () => ({
      workspacePath: scope.workspacePath,
      ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
      ...(targetResolution.remoteSessionId
        ? { remoteSessionId: targetResolution.remoteSessionId }
        : {}),
    }),
    [scope.workspaceIdentity, scope.workspacePath, targetResolution.remoteSessionId],
  );
  if (!targetResolution.rpcReady) {
    return null;
  }

  // 恢复中的远端 pane 可能只有 workspaceIdentity。resolver 已解析出真实
  // remoteSessionId 后若仍把原 scope 传给 registry，会以 __base__ 和远端 endpoint
  // 各建一份数据层，终态可能落到非可见 store。ready 后统一使用解析后的 scope。
  return (
    <ReadyV4PaneConversationProvider scope={resolvedScope} services={targetResolution.services}>
      {children}
    </ReadyV4PaneConversationProvider>
  );
}

function ReadyV4PaneConversationProvider({
  scope,
  services,
  children,
}: Pick<V4PaneConversationProviderProps, "scope" | "children"> & {
  services: IServiceAccessor;
}) {
  const agentService = services.zcodeAgentService;
  const platform = usePlatform();

  // 与 V4ConversationProvider 相同的 useMemo 同步建连模式（renderer 无 StrictMode，
  // memo 双调不存在）；dep 变化时先建新租约再在 effect cleanup 释放旧租约——
  // 同 key 时 refCount 不落零，keep-warm 兜住跨 key 抖动。
  const bundle = useMemo(() => {
    const lease = acquireWorkspaceConnection(
      {
        workspacePath: scope.workspacePath,
        ...(scope.workspaceIdentity ? { workspaceIdentity: scope.workspaceIdentity } : {}),
        ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
      },
      agentService,
      scope.remoteSessionId ? undefined : platform.createLocalMediaPreviewUrl,
    );
    return {
      lease,
      value: {
        layer: lease.layer,
        sendCommand: (envelope: CommandEnvelope) => lease.transport.sendCommand(envelope),
        fileChanges: (params: V4ConversationFileChangesParams) =>
          lease.transport.fileChanges(params),
        fileRewindPreview: (params: V4ConversationFileRewindPreviewParams) =>
          lease.transport.fileRewindPreview(params),
        attachmentPut: (params: V4AttachmentPutParams, options?: AttachmentUploadOptions) =>
          lease.transport.attachmentPut(params, options),
        attachmentRead: (params) => lease.transport.attachmentRead(params),
        attachmentReadRange: (params) => lease.transport.attachmentReadRange(params),
        onRuntimeRestart: (listener: () => void) => lease.transport.onRuntimeRestart(listener),
        ...(lease.transport.onRuntimeLifecycle
          ? {
              onRuntimeLifecycle: (listener: (state: "available" | "unavailable") => void) =>
                lease.transport.onRuntimeLifecycle?.(listener) ?? (() => {}),
            }
          : {}),
      } satisfies V4ConversationContextValue,
    };
  }, [
    agentService,
    platform.createLocalMediaPreviewUrl,
    scope.workspacePath,
    scope.workspaceIdentity,
    scope.remoteSessionId,
  ]);

  useLayoutEffect(() => {
    // acquire 发生在 render，只负责稳定租约；远端 proxy 换代引发的 store 更新和
    // 重订阅必须等到 commit，避免在渲染阶段同步更新现有 pane。
    bundle.lease.activateRemoteService();
  }, [bundle]);

  useEffect(() => {
    return () => {
      bundle.lease.release();
    };
  }, [bundle]);

  return (
    <ServiceProvider services={services}>
      <V4ConversationContext.Provider value={bundle.value}>
        {children}
      </V4ConversationContext.Provider>
    </ServiceProvider>
  );
}
