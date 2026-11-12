# 模型切换：运行时所有权与失败可见

## 背景

Composer 的模型选择器渲染的是 **renderer 草稿意图**（`draftConfig.modelSelection`），不是
Session 的运行时模型。空闭时两者允许分叉（草稿等下一次提交生效）；生成中切换则必须把
意图同步到正在跑的 Pi Session，否则会出现"界面已经切到新模型、上游请求仍是旧模型"。

同步路径现状：

```
Composer 点击
  └─ handleSelectModel            (packages/ui/src/v4/SessionPane.tsx)
      ├─ handleDraftSelectModel    → 草稿（UI 立即显示新模型）
      └─ applyRunningModelSelection
          └─ configCommandBarrier → dispatchConfigCas("switchModelConfig")
              └─ host: switchModelConfig handler   (bootstrap/picode-protocol-v4/commands/handlers/model-config.ts)
                  └─ record.hosted.setModel
                      └─ pi-host applyModel        (pi-host/src/session-registry.ts)
                          └─ session.setModel       (Pi SDK：只改 agent.state.model)
```

Pi SDK 在下一次 model 请求前由 `_installAgentRequestProjection` 重读 `agent.state.model`
（`pi-coding-agent/dist/core/agent-session.js`），因此只要 `session.setModel` 真被调用，本轮
后续请求就会换模型。反过来，所有"切了没生效"都发生在 `session.setModel` 之前。

这条链路上曾有三处**完全静默**的失败：

| 位置 | 静默方式 | 后果 |
| --- | --- | --- |
| `command-inbox.decide` | `switchModelConfig` 属 CAS 命令，`baseRevision` 不精确匹配即 stale；UI 只重试 3 次后放弃 | 命令被丢弃，runtime 从未切换 |
| `session-registry.applyModel` | 同值判定读的是投影 config；`pi.setModel` 返回 `false` 时直接 `return` | 投影与 Pi 脱节后永久 noop，或目标模型不可解析时假装成功 |
| 协议读取当前模型 | 读投影 config 当作"当前模型" | noop 判定建立在派生数据上，而不是 Pi 事实；当前 Pi 路径直接读 `HostedSession.getCurrentModelSelection()` |

三者共同的用户可见结果完全相同：选择器显示新模型、ACK 为 `accepted`、上游仍是旧模型。

## 状态所有者

| 状态 | 所有者 | 说明 |
| --- | --- | --- |
| Session 当前模型 | **Pi `session.model`**（`agent.state.model`） | 唯一执行事实；`switchModelConfig` 与 `sendText` 都改它 |
| V4 投影 `config.provider/model/thought` | ProductProjection | 派生展示。只由真实切换成功后 emit，不得作为切换判据 |
| Renderer 草稿 `modelSelection` | Composer（`useDraftConfigControl`） | 下一次提交意图，允许与运行时不同（空闭时） |
| 模型切换串行化 | `runSessionModelConfigMutation`（Pi 以 hosted session 为 key，旧 Core 以 app 为 key） | 同一会话的 setModel/setThought 单临界区 |

## 规则

1. **模型切换是 last-write-wins，不做投影 revision CAS。**
   `switchModelConfig` 不进入 `COMMANDS_REQUIRING_BASE_REVISION`。理由：它不读投影状态做
   决策（noop 判定读 Pi 事实，见规则 3），而 turn 进行中 `control` / `row.*` 会让
   conversation revision 持续前进，CAS 只会产生"用户意图被 stale 丢弃"的假失败。快速连点
   A→B→C 的顺序由 `configCommandBarrier`（renderer）与 `runSessionModelConfigMutation`
   （host）串行化保证。
2. **切换必须"以结果为准"。**
   handler 在 `setModel` 之后读取运行时 Selection；目标身份变化却读回旧值时抛
   `model.notApplied`，ACK 归一为 `failed`。不得以 `accepted` 结束一次没生效的切换。
3. **同值判定读 Pi 事实，不读投影。**
   `applyModel` 与 `getSessionModelSelection` 都以 `session.model`（经
   `PiSessionPort.currentModel` getter）为判据；投影仅用于展示与 UI 恢复。
4. **模型不可解析必须显式失败。**
   `pi.setModel` 返回 `false`（目标不在 Pi ModelRuntime）时，`hosted.setModel` 抛
   `model.notInRuntime`；只允许 `CommandBridge.useModel` 在 admission 路径上降级为
   `warn`（发送不能因目录抖动被阻断，下一次提交会重新携带选择）。
5. **失败必须让用户看见。**
   renderer 不得只写日志：`switchModelConfig` 的 ACK 若非 `accepted` / `noop`，弹 toast
   （`chat.model.switchFailed`）。草稿保留用户意图，不回滚。
6. **空闭时切换仍只写草稿。** 立即下发命令仅限 `control.phase === "running"`，避免把
   "浏览选择器"变成会话写操作。

7. **同模型只切思考档位也发布真实增量。** `HostedSession.setThinkingLevel` 先调用 Pi setter，再发布 `projector.setConfig` 返回的 delta；协议层不补造 Core `ModelSelected`。Desktop 连续流和手机可回放流都必须收到同一 `config.thought` 变化，不能只改变 Host 内存快照。

8. **冷恢复从 Pi 读取真实档位。** 初始 `config.thought` 与 `thoughtLevels` 分别来自 Pi 当前 `thinkingLevel` 与 `getAvailableThinkingLevels()`；非推理模型只允许 `off`，推理模型由 Pi 解释默认档位与 `thinkingLevelMap`，不能以固定 `medium` 和固定五档替代。首份配置必须与 Pi 恢复结果一致，避免只支持 low/high/max 的模型因非法 medium 无法提交。既有 Composer 草稿仍按自己的有效性规则处理，不靠回写草稿掩盖恢复错误。

## 事件顺序

```
running 中用户切到 B
  UI: draft=B                                  （选择器显示 B）
  UI: switchModelConfig{provider,model,thought}  （无 CAS）
  host: runSessionModelConfigMutation:
        previous = runtime.getSessionModelSelection()   ← Pi 事实
        modelIdentityChanged = previous.modelId !== B
        app.setModel("provider/B")
          → applyModel: currentModel !== B → session.setModel(B)
          → emit projector.setConfig(B)                 （投影追上事实）
        verify: runtime.getSessionModelSelection() === B
        └ 不等 → throw model.notApplied → failed ACK → UI toast
  Pi: 下一次 model 请求 prepareRequest 读到 agent.state.model = B
```

空闲时：只改草稿；下一次 `sendText` 的 `intent.modelSelection` 会走同一
`applyModel` 路径生效。

## 验收场景

1. 生成中切到同 provider 的另一个模型 → 本轮后续请求的 provider/model 为新值；
   `session.setModel` 被调用一次（同值重复点击走 noop，不重复调用）。
2. 目标模型不在 Pi ModelRuntime → ACK `failed` + `model.notInRuntime`，UI 弹 toast；
   投影保持旧模型，不再假装成功。
3. 投影 config 与 Pi 事实脱节（人为把投影改成 B、Pi 仍是 A）→ 再点 B 仍会调用
   `session.setModel`，不被同值短路吞掉。
4. 连续快速切换 A→B→C → 最终 Pi 与投影都是 C，无中间态残留。
5. 空闲时切换 → Session 模型不变；下一次提交的请求使用新模型。
6. 运行中切换期间 tick 的结构性 delta（row/control）不再导致命令 stale 被丢弃。
