# Composer 模型选择：恢复与失效回退

## 背景

Composer 的模型选择器渲染草稿意图（`draftConfig.modelSelection`），而草稿的模型有三种来源，
彼此不共享时效性：

| 来源                           | 写入方                                                             | 时效                           |
| ------------------------------ | ------------------------------------------------------------------ | ------------------------------ |
| 新任务记住的「项目上次提交」   | `captureComposerRecentSubmission`（localStorage，按 workspaceKey） | 启动时一次性写入草稿           |
| 已有会话的会话级草稿           | `persistV4ComposerDraft`（localStorage，scope = sessionId）        | 可能是旧版本、旧目录留下的     |
| 会话真值（Pi `session.model`） | Host `getSessionConfigSeed` → V4 投影 `config.modelSelection`      | 权威，但只在首次初始化时读一次 |

目录（Host `ModelSelectionView`）是候选与可解析性的唯一事实源。远端账号目录会改名
（例如 `grok-4.7-free` → `free/grok-4.7`）、模型会下线、provider 会被移除，记住的值因此可能
在视图里解析不到。

失效时的旧行为：`effectiveSelection` 为 `null` → 选择器停在「选择模型」、
`createComposerSubmissionConfig` 返回 `null` 让发送被挡；而 `draft.mode` 是只写一次的初始化
闩锁，死值永久占位，新任务拿不到项目上次的有效选择或 Host 默认，旧会话也拿不到会话真值。

## 状态所有者

| 状态                     | 所有者                                   | 说明                                                                   |
| ------------------------ | ---------------------------------------- | ---------------------------------------------------------------------- |
| 下一次提交的模型**意图** | Composer 草稿（`useDraftConfigControl`） | 唯一写入方；含用户记住的值与显式选择                                   |
| 展示与提交的**有效值**   | `draftConfig.modelSelection`             | 由 Host `effectiveSelection` 派生；解析不到时才由本规则补一个回退值    |
| 候选目录与可解析性       | Host `ModelSelectionView`                | 候选、账号改写（`resolveEffectiveModelSelection`）、档位集合都以此为准 |
| 会话当前模型             | Pi `session.model`                       | 经 V4 投影只做首次初始化种子                                           |

回退值不是第二份状态：它是同一份视图 + 同一份草稿的纯函数输出，不落盘、不写全局偏好。

## 规则

1. **只有在 Host 给出「解析不到」的结论时才回退。** 判据是当前视图对草稿选择的
   `effectiveSelection` 为空；非空即有效（含 account-plan 被改写到当前连接的 provider），
   不得用默认值覆盖。视图未就绪时不得判定——冷启动的第一份视图可能是尚未投影 Pi 目录的
   registry 视图，它的命名空间与草稿里的 `lens/*` 不同，拿它当结论会把用户记住的模型误判为失效。
   （该窗口内确实会在另一个命名空间上派生一次展示值；因为不回写草稿，Pi 目录到达后原选择
   自动恢复，且不会丢掉用户意图。已配 registry provider 的用户才会遇到。）
2. **回退只派生展示/提交值，不回写草稿。** 草稿继续持有用户记住的原意；目录恢复（或切换到
   Pi 目录）后原选择自动重新生效。失效 id 由「提交被接纳」这条既有路径落定：
   `captureAcceptedModelSelection` 在 ACK 后把真正使用的选择写回草稿。
3. **候选链按作用域。** 新任务：Host 默认（`view.preferredSelection`）；已有会话：会话真值
   （`sessionConfig.modelSelection`）→ Host 默认。候选本身也必须在视图里存在，否则继续下一个。
4. **时序守卫。** 已有会话必须等到会话快照（`sessionConfig` 非空）才允许回退，否则用 Host 默认
   抢在会话真值之前占位；草稿未初始化（无 `mode`）或等待首次分享导入
   （`initializeFromNewTask`）时不回退。
5. **不覆盖用户本次的显式选择。** 显式选模写入的 id 来自当前候选，Host 能解析它，因此不会触发
   回退；即使视图随后换成另一个命名空间，草稿里的显式选择也只会被派生值暂时遮蔽，不会被改写。
6. **不补档位。** 回退只处理模型身份；回退值若不带当前模型支持的档位，选择器仍要求用户显式
   选择档位（发信门禁保持原语义）。
7. **已初始化的空选择仍是确定结果。** 后续 Snapshot 不填满草稿；本规则只影响派生出的有效值，
   不改草稿内容。

## 事件顺序

```
mount(session/新任务)
  └─ 载入 scope 草稿（可能含失效 id）
      └─ ModelSelectionView ready（由首份/落地视图决定，可能先来 registry 视图）
          ├─ view.effectiveSelection 非空 → 直接用（含账号改写）
          └─ 非空判定不成立且草稿已初始化、会话快照已到
                └─ 派生回退值（草稿保持不变）
                      └─ draftConfig / 选择器 / 提交门禁使用派生值
                            └─ 提交 accepted → captureAcceptedModelSelection 写回草稿并持久化
```

## 验收场景

1. 项目上次提交的模型已从目录改名 → 在该项目新建会话时选择器显示 Host 默认模型，而不是空。
2. 已有会话的会话级草稿指向已下线模型 → 打开后选择器显示该会话真值模型（有效时）。
3. 会话真值也失效 → 回退 Host 默认；两者都不可用 → 不派生（保持空白 + 门禁阻断，不写坏草稿）。
4. 草稿里的模型有效 → 不派生，也不改写用户上次的选择。
5. 用户在本次会话里显式切换模型 → 选择与持久化行为不变；视图换源后草稿仍是用户的选择。
6. 冷启动先到达 registry 视图（不含 Pi 模型）→ 不写坏草稿；Pi 目录到达后记住的模型重新生效。
7. 账号改写到当前连接的 pending 选择（`effectiveSelection` 非空）→ 不回退。
8. 目录改名后用户直接发送 → 发送用的是选择器显示的回退模型，ACK 后该模型成为新的记忆值。
