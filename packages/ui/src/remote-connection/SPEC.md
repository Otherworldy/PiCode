# 远程连接向导

## 目录选择

连接成功后的目录步骤强制选一个目录才能继续：没选路径时确认按钮不可用。完整路径由用户决定，向导不替用户猜项目目录。

浏览器起始位置：

| 连接类型 | 起始目录 |
| -------- | -------- |
| 本地 | 系统 `homedir()` |
| WSL / Docker | 远端自己的 `homedir()` |
| SSH | 见下 |

SSH 的起始位置按顺序解析，取第一个可用的：

1. 远端 `$HOME`（通常是 `/root` 或 `/home/<用户>`，实际项目一般都在这里）
2. `/www/wwwroot`（面板类环境）、`/var/www`、`/opt`、`/srv`、`/home` 中第一个存在的目录
3. `/`

解析只读远端文件系统，不写任何东西；失败时按下一档回退，不阻塞目录步骤。起始位置只是浏览器的打开位置，不会被当成用户选择的目录。

## 凭据

SSH 密码只在 Host 进程内存与 0600 私有文件里：连接时写入 `~/.PiCode/v2/ssh-secrets/<hash>.<pid>.secret`，agent spawn env 与子进程只拿文件路径，askpass 从文件读口令。进程退出删除本进程的文件，遗留文件按「属主进程是否存活」回收。

密码认证时 ssh 参数为 `BatchMode=no` + `PreferredAuthentications=password,keyboard-interactive` + `PubkeyAuthentication=no` + `NumberOfPasswordPrompts=1`；主机密钥统一 `StrictHostKeyChecking=accept-new`（TOFU，指纹变化仍拒绝）。
