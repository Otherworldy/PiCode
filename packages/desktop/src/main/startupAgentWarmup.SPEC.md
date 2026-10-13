# 启动时的 Agent 预热

窗口启动时，Main 决定要为哪些本地工作区拉起 app-server。Host 只消费这份名单，不自行补位。

## 所有者

`resolveStartupWindowBootstrap` 是这份名单的唯一所有者。`recentProjects` 只用于项目历史，不参与预热。

## 规则

- 有上次的本地工作区时，只预热本次要恢复的那一个。
- 不因为 `recentProjects` 里还有更早的目录再起 app-server。那些目录里的会话已经停掉，窗口重启后也没有仍在跑的任务。
- 用户之后打开另一个工作区时，仍只预热被打开的那一个。
- 没有可恢复的本地工作区时，只预热 conversation backing workspace。

## 失败

设置读不出或当前工作区目录已经不存在时，沿用原来的恢复兜底。预热名单不因此扩到其他最近项目。
