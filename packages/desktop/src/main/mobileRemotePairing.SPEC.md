# 手机远程控制

## 行为

桌面当前窗口已经有一个 Host。手机只再挂一条 `web-remote-replayable` 端口，不新起 Host，也不新起 Agent。

配对只在用户打开「手机远程控制」并且本机有局域网 IPv4 时监听。地址形如 `http://<局域网 IPv4>:<端口>/?pair=<口令>`。没有局域网地址时不监听，也不把 `127.0.0.1` 当成可用地址。

口令只留在该窗口的内存里。断开、窗口关闭、应用退出后，HTTP 和 WebSocket 都拒绝。再次打开弹层时沿用还没作废的口令，不旋转。同一窗口后连上的手机替换前一个，并摘掉前一个端口。桌面自己的 `desktop-continuous` 端口不动。

二维码里的地址优先用默认路由那块网卡的 IPv4，避免指到 WSL 或虚拟网卡。Windows 只放行这次配对正在听的 TCP 端口。已有规则且端口相同则不再弹窗；否则弹出一次系统确认，用户点「是」即可，不必自己打开防火墙设置。再次打开弹层会按当前端口再检查。本机访问不走这条规则。

手机不带 workspaceKey 时挂本地 Host，并恢复已有工作区标签。侧栏可以切换工作区。手机不把标签变化写回桌面设置。窄屏侧栏盖住页面，点中一条 session 后收起侧栏。收起按钮是图标。前进和后退在窄屏上不显示。会话标题放在顶栏正中。收起后由顶部浮层的侧栏按钮重新打开；收起的侧栏不再接收点击。

Main 只保存这个窗口已打开的工作区目录，用来决定挂哪条端口。键是 `workspaceIdentity?.trim() || workspacePath`。远端条目带 `remoteSessionId`。这里不保存任务、队列或快照。

本地工作区的 Host scope 仍是 `{ kind: "local" }`。现有 schema 不允许在 local scope 上加身份；选中的身份由手机页面打开对应工作区。远端工作区复用 `attachRemoteWorkspaceSessionHost`。

Main 在 WebSocket 和 MessagePort 之间转发 RPC 帧，不解释发送、停止或提问。断线后的下一次挂接仍由 Host 的 replayable 快照补齐。

## 所有者

每个窗口至多一个配对会话，所有者是 Main 的 `createMobileRemotePairingController`。Host 仍拥有会话和快照。
