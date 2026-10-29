# 遥测移除（telemetry removal）

## 背景

产品开源化后移除全部遥测出网链路。原遥测为旁路架构：UI 埋点、host*Telemetry 采集、
V4 会话遥测事实、`@zcode/telemetry` OTLP 导出，最终汇入 ARMS RUM / 数仓端点 / OTEL 端点。
所有端点均由运行时环境变量提供，未配置即不出网。

## 决策

全量移除遥测链路，包括 `ZCODE_TELEMETRY_ENABLED`（曾硬编码 true 的编译期开关）。
移除后不存在任何遥测出网路径，也无编译期常量残留。

## 保留清单（不是遥测，禁止顺手删除）

| 保留项 | 原因 |
| --- | --- |
| `deviceMid`（`packages/services/src/device/deviceMid.ts`、`packages/desktop/src/main/desktopDeviceMid.ts`、`telemetry-state.json` 读写） | `sourceHeaders.ts` 将其作为模型 API 网关与 off-peak 服务的请求头；服务端依赖该身份做设备级关联 |
| 资源管理器链路（`hostResourceUsage.ts` → `resourceManagerHostSampling.ts` → `ResourceManagerApp.tsx`） | 用户可见的 CPU/内存面板功能，与 host*Telemetry 无数据交集 |
| `hostMemoryDiagnosticsLog` 本地 `[memory]` 日志 | 内存问题排查功能 |
| `packages/shared/src/runtimeEnv.ts` 中的 `OTEL_*` / `ZCODE_TELEMETRY_*` 剔除名单 | 安全防护：旧部署环境里残留的端点与鉴权变量必须继续从子进程 env 中剔除，不能泄漏给 Bash / MCP / 工具子进程 |
| `v4/turn/lifecycle` 通知与 `TurnLifecycleFact` | **功能而非遥测**：`zcode-server-cli` supervisor 用它统计运行中会话数，在有任务时阻止 server 更新 / 卸载。只携带 sessionId 与终态 |
| `ModelApiOperation` / `ModelApiErrorPhase` 等（`contracts/src/model/apiCall.ts`） | 功能类型：调用点声明 operation/actorKind，adapter 用它归类失败阶段 |

## 协议边界

- 删除 `v4/telemetry/event`（会话遥测事实）与 `v4/telemetry/local-ttft`（TTFT 事实）两条 live 通知。
- 新增 `v4/turn/lifecycle`：只承载 `turn.started` / `turn.terminal`，供 server supervisor 统计运行中会话数。仅可信 Host relay 可订阅。
- `conversationTopicFrameSchema` 上的 `ttft` / `ttftRelated` 可选字段与 command 信封的 `ttft` 字段一并删除。
- 遥测事实从不进入 topic snapshot/recovery，`web-remote-replayable` 恢复链路不受影响。
- 旧版本对端若仍发送 `v4/telemetry/*` 通知，按未知通知忽略（transport 既有行为）。

## 后续可做的清理

- `packages/shared/src/runtimeEnv.ts` 的 `OTEL_*` / `ZCODE_TELEMETRY_*` 剔除名单是兼容性防护，可在确认旧部署环境不再存在这些变量后移除。
- `apps/zcode-cli` 的 workspace lockfile 因 `@zcode/model-option-map` 缺失（与本改动无关的既有问题）无法重新生成，`@sentry/*` 孤儿条目已手工移除。

## 验收

- `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 通过。
- 全仓库无 `@zcode/telemetry`、`@arms/*`、`@opentelemetry/*` 源码引用与依赖条目。
- `ZCODE_TELEMETRY_*`、`ZCODE_ARMS_RUM_ENDPOINT`、`OTEL_EXPORTER_OTLP_*` 无源码残留。
