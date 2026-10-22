# 回退时的文件撤销

## 产品规则

- 「回退到此处」选定总结方式后，若这条消息之后有文件改动，先弹确认框，让用户决定是否把这些文件恢复到回退点之前。
- 确认框两个动作：**只回退对话**（保留文件现状）、**撤销文件并回退**（撤销文件并裁切对话）。
- 没有文件改动时不弹框，直接回退。
- 存在不能安全撤销的文件（外部改过、checkpoint 缺失）时，「撤销文件并回退」置灰，仍允许「只回退对话」。这与编辑重发时 `workspaceMode=rewind` 的 fail-closed 不同：回退不重发，用户有权只裁切对话。
- 撤销范围是**后缀**：回退锚点这条用户消息及其之后所有 turn 的文件改动，不是只有该 turn。否则回退到几轮之前时会留下后面几轮的改动。
- bash 改动（`ignoredFiles`）无法撤销，但不阻止回退：确认框照常列出，用户点「撤销文件并回退」时只撤能撤的，其余保持现状。

## 状态所有者

| 层       | 所有者                                                    | 内容                                                                |
| -------- | --------------------------------------------------------- | ------------------------------------------------------------------- |
| Renderer | `UserInputRowView`（`ConversationRowView.tsx`）           | `fileRewindPrompt`：待确认的 preview + 待执行的总结选择             |
| 协议     | `editUserQuery.workspaceMode`                             | `preserve`（只裁切）/ `rewind`（先撤文件再裁切，缺省 preserve）     |
| 协议     | `fileRewindPreview` 的 target 行类型                      | user 行 → `scope: "suffix"`；turnHeader 行 → `scope: "turn"`        |
| CLI      | `conversation-rewind.ts` `restoreUserQueryToInput`        | 回退到此处全流程：可选文件撤销 + 裁切，同一条命令                   |
| Runtime  | `previewWorkspaceFileRewind` / `applyWorkspaceFileRewind` | `expandSuffix`；core 与 Pi host 各有一套实现                        |
| CLI      | `product-projection.resolveRowActionTarget`               | user 行只放行 `fileRewindPreview`；`applyFileRewind` 仍只走 turn 行 |

preview 与 apply 共用同一套 `{ canApply, safeFiles, unsafeFiles, ignoredFiles }`，UI 不自行推算可撤销性。

## 时序

```
点「回退到此处」→ 选总结方式
  → fileRewindPreview(target = 该 user 行, scope=suffix)   // 失败：logger.warn + 直接回退，不动文件
  → 无任何文件改动：editUserQuery(restoreToInput, workspaceMode=preserve)
  → 有文件改动：打开确认框，保留 choice
       ├─ 只回退对话      → editUserQuery(restoreToInput, workspaceMode=preserve)
       └─ 撤销文件并回退  → editUserQuery(restoreToInput, workspaceMode=rewind)
                            CLI 内部：preview(suffix) → 不安全则 blocked（不写文件、不裁切）
                                      → applyWorkspaceFileRewind(suffix, commitAfterApply=裁切)
```

- 文件撤销与对话裁切必须在**同一条命令**内完成。分成两条 CAS 命令时，文件撤销会 bump revision，随后的裁切拿着旧 revision 被判 stale，回退必然失败；而且文件已撤销、对话还在，用户无法从界面恢复。
- 命令内的顺序是先文件、后对话：`commitAfterApply` 在文件全部写成功后才提交 branch cut。裁切抛错时文件按 journal 补偿写回，`restoreRewoundConversation` 再把 jsonl 画回去。
- blocked 走 `status: "accepted"` + `result.disposition: "blocked"`，客户端必须读 `result`，不能只看 `ack.status`；否则会把「什么都没做」当成功，把原文填回输入框。
- `previewFileRewind` 缺席（只读 / 远程未启用）时跳过预检，保持「只回退对话」的旧行为。

## 服务端语义

- suffix 有两条实现，锚点各取所需：
  - core（`file-rewind.ts`）：`expandSuffix` + `targetMessageId`，用 active chain（`activeSessionMessages`）展开，不用 projection 窗口。
  - Pi host（`pi-hosted-app.ts` / `pi-host/file-rewind.ts`）：`expandSuffix` + `targetTurnId`，按投影窗口的 turnHeader 顺序取锚点及之后的 turn。Pi 是桌面与 CLI 的主路径，preview/apply 由宿主实现覆盖，只认 turnId。
- 两条实现都在展开落空时 fail closed（返回空 preview），绝不退化成「最后一条 checkpoint」。
- 多 turn 的写操作按事件顺序合并后从新到旧撤销，同一文件以最早状态为准；逐 turn 各算一遍会拿当前磁盘去校验更早的 checkpoint，得到错误的 unsafe。
- Pi host 没有 checkpoint：`Write` 只能从 diff 判断自己是否覆盖了已有内容。覆盖过的 Write 判 `checkpoint_missing`（撤不回去，退回成删除会把锚点前的文件一起删掉），只有新建文件的 Write 才退回成删除。
- 撤销后把后缀内每个 turn 的 `fileChanges.state` 都标记为 `reverted`（Pi host）。对话同时被裁切，后续行不再存在。

## 验收场景

- 回退到最近一轮（该轮改过 2 个文件）：弹框列出 2 个文件；点「撤销文件并回退」后文件内容恢复、对话裁切。
- 回退到 3 轮之前（中间几轮都改过文件）：确认框列出全部后缀文件，撤销后不留残余改动。
- 该点之后没有任何文件改动：不弹框，直接回退。
- 有文件被外部改过：确认框列出 unsafe 文件与原因，「撤销文件并回退」置灰；「只回退对话」可用，对话裁切后文件保持现状。
- 只有 bash 改动：确认框列出 ignored 文件，「撤销文件并回退」可用（撤销其它可撤文件后裁切对话）。
- 命令被判 blocked：不填输入框、不裁切对话，toast 说明原因，日志有 warn。
- 预检失败：日志有 warn，界面按「只回退对话」处理，不静默撤销任何文件。
- 回退入口中途被收回（转只读、分支总结开始）：确认框一起关闭，不会留下点了没反应的按钮。
- 双击确认按钮：只发一条命令，不会出现「成功后紧跟一条 stale 假失败」。
- 该点之后有覆盖已有文件的 Write：确认框把它列为不可安全撤销，「撤销文件并回退」置灰，文件不会被删。

## 已知边界

- `applyWorkspaceFileRewind` 把 `commitAfterApply` 的异常并入「文件写失败」处理：若裁切已提交、随后的 legacy 广播抛错，文件会被补偿写回而对话留在裁切态。这是既有 core 行为，编辑重发路径同样受影响，本次未改。
- Pi host 的 Edit 撤销只校验 `newText` 在当前内容里唯一出现，不比对整份内容哈希，外部改动可能被漏判。core 有 checkpoint 哈希校验，不受影响。
