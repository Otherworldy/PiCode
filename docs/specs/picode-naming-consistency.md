# PiCode 命令与工程命名一致性

## 范围与产品规则

PiCode 当前界面名称已更新，但 CLI、安装器、Linux 桌面命令、workspace 包名和源码路径仍使用旧品牌。本次统一当前工程及用户入口，保留承担数据/通信兼容或上游归属的名称。

- CLI 主命令为 `picode`，进程名为 `picode-cli`。只有主 Agent CLI 的 Node 包保留 `zcode` bin 别名，二者进入同一实现。分发安装器创建 `picode`，不改写旧 `zcode` 命令；发行包保留转到新 runner 的 `bin/zcode.mjs`，使旧安装器留下的 wrapper 升级后仍可运行。已有 `picode` 仅在是同一安装根的标准 wrapper 时允许更新；其他文件或符号链接在切换 current 前报错退出。
- Linux 桌面 executable/package 名使用 `picode-desktop`，Preview 使用 `picode-desktop-preview`，与 CLI 分开。productName 保持 PiCode / PiCode Preview。
- 分发包、构建入口、帮助、README 同步使用 picode；无参只打印帮助，`--web` 才启动 Web；不宣传终端 TUI。
- Server CLI 的 Node bin、发行主 launcher 为独立的 `picode-server`，不注册主 CLI 的 `picode` / `zcode` bin；开发环境缺少内嵌 Agent 时的无参提示也使用 picode-server 用法，不再宣称 TUI。新发行目录为 `picode-server-<target>`；更新解包仍识别旧 `zcode-server-<target>`，稳定安装保留旧 `zcode` launcher 指向同一 Server 实现，避免已有系统服务入口失效。
- workspace 内部包 scope 统一为 `@picode/*`，仓库根包为 `picode`。源码目录/文件名和静态 import/export、workspace、TS、构建脚本、架构规则及现行指令引用同步迁移。
- 旧 `build:zcode` 仅作为 `build:picode` 的显式脚本别名保留；不保留第二条构建实现。
- 本地实现符号不做无关语义重构；公开 Core API、wire payload 字段和运行时服务描述符保持兼容。

## 唯一所有者与接口

CLI 的命令与进程名称由现有 process-name 模块持有；安装器/runner 继续使用现有分发链路。桌面正式/Preview 身份由 desktop-product-identity 模块持有。package.json 是包名与 bin 映射的来源；源码移动同步维护所有入口，不创建双份实现。

```text
用户调用 picode / 旧 bin 别名 → 现有 CLI/发行 runner → 同一 app-server 或 Web 入口
Linux 桌面 picode-desktop → 现有 Electron Main → window-scoped Host → 同一 Agent
```

只改变名称和静态寻址；CommandInbox、Host owner/lease、workspaceIdentity、Desktop continuous 与手机 replayable 事件顺序保持原契约。

## 明确保留的兼容边界

- `dev.zcode.app` / Preview appId、现有 Windows AUMID 和 `zcode://` 协议保持原值，不在本轮改变安装身份或正式/Preview 回跳归属。
- `window.zcode`、IPC/RPC 服务名、MCP `com.zcode/*`、HTTP header 与 payload 字段保持 wire 值；仅移动其定义文件和 import 路径。
- `ZCODE_*` 环境变量保持现有输入契约；不建立第二套环境配置。
- 已有主题、草稿、待确认输入、数据库、缓存、安装所有权标记及原生 helper 身份不改名；Agent 已交付的 `zcode.cjs` / 原生兼容入口继续由当前 runtime descriptor 与构建链使用。现有 `.zcode`、`zcode.json`、`.zcodeignore` 迁移/回退保持。两个用户目录都存在时仍不合并数据。
- `.zcode-plugin` 作为已支持的插件清单格式保留。内置 provider 下载/缓存格式、第三方产品/端点和上游 ZCode 致谢保留。发行元数据主页更新为当前 PiCode 仓库；不编造新的联系邮箱，删除不准确的旧联系人信息并保留有效作者字段。
- 不修改历史 CHANGELOG、Git 历史、用户数据或工作区记忆。源码移动不恢复已移除模块。第三方 copied-components 输入随源码路径更新；已生成的声明与 inventory 必须由现有生成器同步刷新。若缺少上游材料导致生成失败，保留原始快照并报告门禁未通过，不能手工更新摘要冒充已生成。

## 失败与兼容

内部包或路径的遗漏必须在 typecheck/build 中暴露，不能用旧 source 路径的转发文件隐藏。保留旧 CLI bin 只做同入口别名；不抢占已存在的系统命令。安装和分发必须执行新入口，不允许帮助文本改名后实际 bin 仍只有旧名。远端/原生运行时兼容文件名需保留显式用途，不能机械替换持久化或协议标识。

## 验收

1. 主 CLI 和旧 bin 别名解析到同一产物，中文/英文 help 和版本输出可执行；无参无 TUI。
2. 发行 installer 创建 picode，runner 的 `--web --help` 显示新命令；安装提示只描述实际入口。覆盖全新安装、旧本产品 wrapper 升级、旧命令第三方文件/符号链接保留，以及新主命令第三方文件/符号链接占用时的无损拒绝；重复安装幂等。
3. Linux 正式/Preview 身份的 executable/package 名独立于 CLI，appId/scheme 不变；Server CLI 使用独立 picode-server bin，稳定目录保留旧服务入口。
4. 所有 workspace 包依赖、公开出口和源码引用解析到新路径；生成的运行时产物与消费者一致。旧工程路径没有悬空引用，兼容清单中的 wire/数据旧名仍保留。
5. 必须执行根 typecheck/lint、架构检查、CLI 聚合检查（已有失败如实报告）、相关包构建，以及命令、分发、平台身份、数据迁移的针对性验证。包移动后刷新本地依赖链接，锁文件不升级依赖版本。
6. 完成独立源码复核。未实际验证的平台安装/升级与 OAuth 回跳不得声称通过。
