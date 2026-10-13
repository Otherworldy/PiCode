# 移动端远程控制

## Context

Bot Channel 已删除，侧栏入口也没了。手机要看并控制这台桌面当前窗口里已经打开的会话：发消息、停止、回答提问，断线后接着看。

已选定：

- 只做同一局域网。桌面给地址和二维码，手机与电脑在同一个 Wi-Fi。不做公网中继。
- 手机先看到这个窗口里已打开的工作区，再进入其中一个。不另起 Agent。
- 复用现有对话界面。手机上不带文件树、终端、设置这些桌面专属能力。
- 扫码即进。桌面可以断开。关掉窗口后旧地址失效。不要求登录 Z.AI。

不做：

- 不为手机另起 Agent、Local Host、远程会话或 Pi。
- 不走 `pnpm dev:web`，也不走 `?remote=`。那是另一套 `@zcode/server`，而且 `/ws/remote/:id` 只桥接文件、Git、系统和终端。
- 不合并 `desktop-continuous` 与 `web-remote-replayable`。
- Main 不保存任务队列或快照。工作区列表只用于把手机挂到已有 attachment。

## Approach

当前窗口已经有一个 Host。桌面 Renderer 用 `AttachServicePort` 挂着，`clientMode` 是 `desktop-continuous`。手机再挂一条端口，`clientMode` 换成 `web-remote-replayable`，Host 进程不增加。

1. 用户在桌面打开「手机远程控制」。Main 只在这段配对有效时监听局域网端口，生成一次性口令，界面显示 `http://<局域网地址>:<端口>/?pair=<口令>` 和二维码。
2. 口令只放在内存，绑住这个窗口。断开、窗口关闭或口令作废后，HTTP 和 WebSocket 都拒绝。日志里不写口令。
3. 手机打开后先向 Main 要这个窗口已打开的工作区。列表用 `workspaceIdentity?.trim() || workspacePath`，远端再带 `remoteSessionId`。这不是任务队列。
4. 选中后，Main 建 `MessageChannel`，把一端交给这个窗口现有的 Host：
   - 本地工作区：`scope.kind = "local"`，并带上该工作区身份。
   - 远端工作区：复用 `attachRemoteWorkspaceSessionHost`，`clientMode` 已是 `web-remote-replayable`。
5. Main 只在手机 WebSocket 和这条 MessagePort 之间转发 RPC 帧。不解释发送、停止或提问。
6. 手机加载现有 Web UI，用 `connectViaWebSocket` 连这个桥，`isDesktop = false`。不要调用 `connectRemote`，也不要打开新目录。进入的就是刚选中的那个已连接工作区。
7. 同一窗口同时只留一个手机连接。新的扫码连接替换旧的，并 `DetachServicePort`。桌面自己的端口不动。
8. 断线重连仍用现有 replayable 快照。publisher 还没有行时先读 Pi jsonl，避免空画面。

现在 Main 的 `SyncWindowTabs` 只收本地路径，而且 UI 会故意去掉带 `remoteSessionId` / `workspaceIdentity` 的远端标签。手机列表不能用这套路径集合，否则远端标签不会出现，本地也分不清身份。

## Files to modify

- `packages/desktop/src/main/`：新增配对监听、二维码所需的地址、WS↔MessagePort 转发、断开时摘掉手机端口。不放进 Host。
- `packages/desktop/src/main/desktopWindowLifecycle.ts`：对照这里给存活 Host 再挂端口的做法，手机挂接不重启 Host。
- `packages/desktop/src/main/desktopRemoteSessions.ts`：远端工作区走已有 `attachRemoteWorkspaceSessionHost`。
- `packages/ui/src/root/useRootPlatformEffects.ts`：窗口标签同步补上身份和 `remoteSessionId`，供 Main 做挂接调度。保留现有「远端路径不能当成本地路径」的边界。
- `packages/ui`：侧栏恢复一个入口和弹层，只显示地址、二维码、断开。替换已删除的 Bot 弹层。
- `packages/web/src/main.tsx`：增加手机配对启动。校验口令，拉工作区列表，选中后再 `connectViaWebSocket`。`allowOpenWorkspace={false}`，`supportsEmbeddedBrowser={false}`，不走 `?remote=`。
- `packages/shared`：只补配对和窗口工作区列表所需的类型。不新造会话协议。

不改 `packages/server` 的 `/ws` 与 `/ws/remote/:id`。

## Reuse

- Host 已写明 Renderer 和手机都挂同一窗口 Host：`packages/desktop/src/host/index.ts`。
- 再挂一条端口：`desktopWindowLifecycle.ts` 里 renderer reload 的 `AttachServicePort`。
- 远端 replayable 挂接：`attachRemoteWorkspaceSessionHost`。
- 浏览器 RPC：`packages/client/src/websocket.ts` 的 `connectViaWebSocket`。
- 手机页面：`packages/web/src/main.tsx` 已把 `Root` 挂到 WebSocket 服务上。桌面布局里 `isDesktop === false` 的分支继续用来收起桌面 chrome。
- 两套 flush、同一投影：`apps/zcode-cli/packages/pi-host/SPEC.md`。replayable 150ms，continuous 30ms。快照可从 Pi jsonl 重建。

## Steps

- [x] Main 在配对开启时监听局域网，返回地址和一次性口令；断开、关窗口或替换连接时作废。
- [x] 桌面弹层显示二维码、地址和断开。无局域网地址时说明手机连不上，而不是显示 `127.0.0.1` 冒充可用。
- [x] 窗口工作区列表含本地和远端标签，键是 `workspaceIdentity?.trim() || workspacePath`，远端带 `remoteSessionId`。
- [x] 手机先选工作区。选中后把 WebSocket 转到该窗口现有 Host 的新 replayable 端口。
- [x] 现有对话界面打开这个工作区：能看会话、发送、停止、回答提问。不能从手机新开目录或另起远端连接。
- [x] 断线重进同一工作区时用快照补齐，桌面 `desktop-continuous` 会话不中断，终态一致。
- [x] 补测试：第二个端口是 replayable，Host 进程不增加；旧口令在断开后被拒绝。

## Verification

- 桌面一个窗口里同时开着本地和远端工作区。手机扫码后能看到这两个，进入正在跑的那条会话，而不是空输入框或新会话。
- 手机发送、停止、回答提问，桌面同一条会话跟着变。
- 手机断网再打开，缺口由快照补上，终态与桌面一致。
- 桌面断开或关掉该窗口后，旧地址和旧口令不能再连。另一个窗口的工作区不会出现在这张二维码里。
- `pnpm typecheck`、`pnpm lint`，以及上面的挂接测试。全仓库里与这次无关的旧失败如实标出，不写成通过。
