# Git 自动刷新的监听边界

## 背景

`useGitAutoRefresh` 在 Git 自动刷新打开时注册 `fs.watch`，用来让右上角的脏状态尽快跟上
工作区的真实情况。原实现按平台分了两条路：

- Linux：只监视服务端解析出的 Git 元数据目录（`.git`、common dir），工作区内容靠 5 秒轮询。
- 非 Linux（Windows / macOS）：额外把**整个 `workspacePath`** 以 `recursive: true` 交出去，
  因为「只盯 `.git` 时，未进 index 的文件改动不碰元数据，脏状态会停住」。

第二条路的问题不在 Node 层，在内核层：`recursive: true` 会为整棵目录树注册 watcher
（Windows `ReadDirectoryChangesW`、macOS FSEvents）。仓库里有 `node_modules`、构建产物、
生成目录时，每次文件写入都会产生目录通知并回调到 Host；`ignoreDirectoryNames` 只能在
**回调里**把路径滤掉，挡不住通知本身和线程池调度。`fs.watch` 的 ignore 选项在 Node 里
也不存在，无法下推到内核。

同一处还有第二个问题：`isIgnoredWatchPath` 每次回调都 `new Set(directoryNames)`。递归监视
在跑的时候，每个文件事件一次分配，正好叠加上面的通知量。

## 规则

1. **工作区根永远不进 `fs.watch`，不分平台。** 监听范围只有服务端给出的 Git 元数据路径
   （`.git`、`git-common-dir`，linked worktree 下可以位于 workspace 之外）。工作区内容改动
   由 `GIT_AUTO_REFRESH_POLL_MS`（5 秒）轮询负责。
   - 这条同时兼容旧 remote server：历史 summary 仍可能携带 `workspacePath` 递归项，过滤
     规则按路径相等丢弃，与平台无关。
2. **平台不再是输入。** `buildGitAutoRefreshWatchPaths` 只吃 summary。删掉平台探测之后，
   `useGitAutoRefresh` 不再为它调一次 `systemService.info()`，workspace 切换时也少一个异步
   竞态点。
3. **性能敏感的不可变集合在注册时构造一次。** `watch()` 时期把 `ignoreDirectoryNames` 收成
   `ReadonlySet`，回调里只做 `has` 查找。

## 代价

保存文件后，右上角的脏状态从「约 1 秒」变成「最多 5 秒」出现，与今天的 Linux 一致。
提交、切换分支、改 index、改 HEAD 仍然走 `.git` 元数据 watcher，是实时的。
`shouldPollGitWorkspaceContent` 因此在所有平台都返回 true，5 秒轮询成为工作区内容变更的
唯一来源。

## 验收场景

- 任意平台：`buildGitAutoRefreshWatchPaths` 的结果里没有 `workspacePath` 本身；旧 remote
  server 下发的 `{ path: workspacePath, recursive: true }` 被丢弃。
- 打开一个含 `node_modules` 的仓库，连续写入工作区文件：Host 收不到 `fs.watch` 回调
  （只有 5 秒一次的 `git status`）。
- `.git/index` 变化，1 秒内触发刷新。
- 同一个 watcher 连续两次判定忽略路径时，使用的 Set 是同一个引用。
