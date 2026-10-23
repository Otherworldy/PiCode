# 主进程热路径上的同步 IO

## 背景

Electron 主进程跑在 UI 线程上。这里的同步 IO 直接冻结所有窗口——不是「慢一点」，是白屏、
拖窗口掉帧、右键菜单不响应。两个高频入口：

1. **日志**。`logger.write()` 每行做一次 `mkdirSync` + 一次 `appendFileSync`。而
   `rpc/logging-middleware.ts` 给**每个服务端 RPC 调用**都打一条 info 日志，host 的
   `console.log` 又被覆盖成 `postMessage` 转到 main 的同一出口。于是「renderer 每一次 RPC」
   = 主线程两次同步 fs 调用。
2. **编辑器探测**。`resolveWindowsCommandPaths` 用 `execFileSync("where.exe")`，而
   `getInstalledEditors()` 虽然声明为 `async`，同步段跑在第一个 `await` 之前。ui 有 5 个
   互不相关的挂载点在首屏并发调用它，且没有 in-flight 去重。

## 规则

### 日志

1. **目录只在打开新文件时创建。** `LOG_DIR` 在模块初始化已经 `mkdirSync` 过；跨日切文件时
   再建一次，正常写入路径上零次。
2. **用持久的 `WriteStream`，不用每行 `appendFileSync`。** `appendFileSync` 每次
   open/write/close，`WriteStream` 保持句柄。跨日或日志目录变化时关闭旧流、开新流。
3. **写入失败不影响应用。** 流上挂 `error` 监听吞掉错误，与原来的 `try/catch` 等价。
4. **接受进程强制退出时丢失尾部日志。** `process.exit()` 不等待流 flush。这是换取主线程
   不阻塞的代价；崩溃诊断依赖的是 `desktopCrashCapture` 而不是日志尾部。

### 编辑器探测

1. **子进程必须异步。** `execFileSync("where.exe")` 在主线程上最长可卡 `timeout: 1000`，
   串行 6 个候选 × 5 个并发调用点。改用 `execFile` + Promise。
2. **`getInstalledEditors` 必须有 in-flight 去重。** 5 个挂载点同时调用时只能跑一次探测。
   缓存只在结果落地后赋值，不能靠它挡住并发。
3. **模块 import 期间不做文件系统遍历。** JetBrains 候选路径的 `readdirSync` 从模块顶层
   常量移到懒加载函数，首次使用时才扫。

## 不做的事

不把 `existsSync` 改成异步。单次 `existsSync` 在本地盘是微秒级，一次探测几十次累加也在毫秒内，
而改异步会让 `resolveEditorDefAppPath` 的整条调用链扩散到更多调用点。真正的问题在
`execFileSync`（毫秒到秒级）。

## 验证方式

- 流式对话期间观测主线程：`[rpc:call]` 日志量不变，但没有对应的同步 fs 抖动。
- 首屏同时挂载多个编辑器按钮：`where.exe` 只 spawn 一轮。
- 日志文件仍按日期分文件、内容顺序正确。

## 追加：列会话只读 summary 行

`pi-host/src/session-registry.ts:729-733` 在 `for (const file of files)` 里对**每个** `.jsonl`
做 `readFile(sessionFile, "utf8")` 再 `readPiJsonl(content).summary` —— 只为取一个 summary
就读了整个文件。2000 个会话 × 平均 500KB = 列一次读 1GB、解析 1GB，峰值同时挂着
`content` 与 `summaries`。

规则：**只需要文件头信息的枚举操作，不得全量读取。** summary 是 jsonl 首行，用
`readline` 读第一行即可；读不出来（文件损坏）时降级为「跳过该会话」而不是读全文重试。
