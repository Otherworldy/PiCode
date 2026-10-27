# 远程连接向导

## 目录选择

连接成功后的目录步骤强制选一个目录才能继续：没选路径时确认按钮不可用。完整路径由用户决定，向导不替用户猜项目目录。

浏览器起始位置：

| 连接类型     | 起始目录               |
| ------------ | ---------------------- |
| 本地         | 系统 `homedir()`       |
| WSL / Docker | 远端自己的 `homedir()` |
| SSH          | 见下                   |

SSH 的起始位置按顺序解析，取第一个可用的：

1. 远端 `$HOME`（通常是 `/root` 或 `/home/<用户>`，实际项目一般都在这里）
2. `/www/wwwroot`（面板类环境）、`/var/www`、`/opt`、`/srv`、`/home` 中第一个存在的目录
3. `/`

Windows 远端只有两档：`%USERPROFILE%`，缺失或非法时回退到系统盘根（`C:\`）。

解析只读远端文件系统，不写任何东西；失败时按下一档回退，不阻塞目录步骤。起始位置只是浏览器的打开位置，不会被当成用户选择的目录。

## 凭据

SSH 密码只在 Host 进程内存与 0600 私有文件里：连接时写入 `~/.PiCode/v2/ssh-secrets/<hash>.<pid>.secret`，agent spawn env 与子进程只拿文件路径，askpass 从文件读口令。进程退出删除本进程的文件，遗留文件按「属主进程是否存活」回收。

密码认证允许空口令（无密码账户）：`password: ""` 与 `password: undefined` 语义不同——前者是「密码认证 + 空口令」，后者是「未选择密码认证」。空口令同样落 0600 凭据文件（内容为空行），askpass 输出空口令，ssh 参数与有口令时一致（`BatchMode=no` 等）。整条链路（表单校验、target 构造、凭据文件、历史快照、重连恢复）必须用 `typeof password === "string"` 判断，不能用 truthiness，否则空口令会被当成「没有密码」退回公钥认证。

空口令能否登录由远端 sshd 决定（OpenSSH 默认 `PermitEmptyPasswords no`，Windows OpenSSH 不允许空密码账户远程登录）。产品只负责如实表达这个输入，不做本地放行判断。

密码认证时 ssh 参数为 `BatchMode=no` + `PreferredAuthentications=password,keyboard-interactive` + `PubkeyAuthentication=no` + `NumberOfPasswordPrompts=1`；主机密钥统一 `StrictHostKeyChecking=accept-new`（TOFU，指纹变化仍拒绝）。

## 连接验证

「连接中」步骤必须真实执行一次远端命令（`echo`，cmd 与 POSIX shell 都有）验证认证，认证失败在连接步骤报错，不能等到目录步骤第一次读目录才暴露。

探测按「每次连接」执行，不能只在首次建连时做：registry 按 `host/port/user` 复用已 online 的 entry，同一窗口再连同一主机不会重新建 handle，只在 handle 工厂里探测会漏掉这一类。

目录步骤的起始位置探测仍按「失败回退」处理，与连接验证分开。

SSH config 别名没有 `IdentityFile` 时，表单会把认证方式置为密码认证且密码为空，提交的就是空口令密码认证（`PubkeyAuthentication=no`）。依赖 agent 或 ssh_config 的别名需要显式选私钥认证。

## Windows 远端

连接阶段先试 PowerShell 自身（`$env:OS`，经 EncodedCommand），失败再试 `uname -s`，结果写入 `SshRemoteSpec.platform`（`posix` / `windows`）。必须先试 PowerShell：装了 Git for Windows / MSYS2 / Cygwin 的 Windows 上 `uname` 会返回 `MINGW64_NT`，先看 `uname` 会把整台 Windows 判成 posix。缺省按 `posix`，因为旧 Host 写入的 `ZCODE_SSH_REMOTE` 没有这个字段；脏值只丢字段，不能让 spec 失效（否则远程工作区会退化成改本机文件）。

Windows 远端的所有命令走 `powershell -NoProfile -NonInteractive -EncodedCommand <base64/UTF-16LE>`：

- 外层 shell 可能是 cmd 也可能是 PowerShell（取决于 Windows OpenSSH 的 `DefaultShell`），直接拼引号会被解析两次；base64 不含特殊字符，两种外层都能执行。
- 脚本前缀固定 `$ProgressPreference='SilentlyContinue'`（否则 stderr 混进 CLIXML）与 `[Console]::OutputEncoding=UTF8`（否则中文文件名乱码）。
- 目录列表用 `Get-ChildItem -Force` 输出 `d|f|l\t名称`，与 POSIX 的 `find -printf '%y\t%f'` 同一解析路径。
- 读文件片段用 base64（PowerShell 的 stdout 编码会改字节）；整段文本用 `[Console]::Out.Write(ReadAllText)`，直接输出字符串会被 PowerShell 补一个换行。
- 写文件走 `scp`，不用 stdin：外层 PowerShell 会缓冲子进程 stdin，实测超过约 4KB 整条连接挂死。别名连接时 scp 目标只写别名，避免绕开 ssh_config 的 HostName/Port。
- agent 的 bash 工具把模型写的 PowerShell 命令连同 `Set-Location` 一起编码，并把 `$LASTEXITCODE`/`$?` 映射回退出码；`sshWorkspacePrompt` 同时改成「用 PowerShell、Windows 路径」，否则模型仍会写 POSIX 命令。

目录浏览器的父目录推导与根判定不再写死 `/`：`C:\` 也是根，`..` 用 `getContainingDirectoryPath` 推导。

已知限制：workspace identity 里的路径段仍按 `/` 归一（`C:\work` → `/C:/work`），只作为身份键使用，真实 IO 用原路径；Windows 远端不提供工作区索引搜索、媒体预览与符号链接解析（与 POSIX 远端一致）。

命令退出码：Windows OpenSSH 的 DefaultShell 外面还包一层 shell，内层 `powershell -EncodedCommand` 的非零退出码会被外层统一压成 1（实测 `exit 7` 经双层 PowerShell 返回 1）。因此 agent 的 bash 工具在 Windows 远端只能可靠区分成功/失败，拿不到具体退出码；POSIX 远端不受影响。

命令行长度：Windows 侧脚本以 base64（UTF-16LE）进 `-EncodedCommand`，膨胀约 2.67 倍。DefaultShell 是 cmd 时整条命令行受 8191 字符限制，模型写超过约 3KB 的脚本会报 `The input line is too long`；DefaultShell 是 PowerShell 时上限高得多。

隐藏项：Windows 没有 POSIX 点文件约定，`Get-ChildItem -Force` 总是返回隐藏项，目录浏览器的「显示隐藏目录」开关在 Windows 远端不生效。
