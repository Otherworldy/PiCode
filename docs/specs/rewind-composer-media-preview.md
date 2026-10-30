# 回退到此处：回到输入框的媒体附件仍可用

## 产品规则

- 「回退到此处」把目标用户消息的正文与附件一起交回输入框。正文可以直接编辑，附件必须是**可用的 chip**：
  图片/视频/PDF 显示缩略图、能点开预览、能直接再次发送。
- 附件内容仍由 session 持有（`referenceOwnership: "session"`），回退不重新上传、不重复 adopt。
- 读取失败（附件已不在、超出预览上限）时降级为文件图标；回退本身不受影响。

## 状态所有者

| 状态                                              | 所有者                                                                        |
| ------------------------------------------------- | ----------------------------------------------------------------------------- |
| 媒体缩略图源（object URL / Desktop 本地媒体 URL） | `SessionPane` 的一次性读取，随 `ComposerRestoreRequest` 移交                   |
| 附件 chip 的 `objectUrl` 生命周期                 | `packages/ui/src/store/composerAttachmentUploadStore.ts` 里的 composer 附件项  |
| 附件 ref 的归属                                   | 不变：session 拥有 ref，composer 只持有引用                                   |

`buildSessionOwnedComposerAttachments()`（`packages/ui/src/v4/composer/sessionOwnedComposerAttachments.ts`）
是「session 拥有的 ref → composer chip」的唯一构造点。

## 为什么必须在裁切前读

`v4/attachment/read` 先由当前投影里的 `userInput` 行证明 ref 归属，再按 ref 读字节
（`v4-gateway.ts` 的 `resolveReadableMediaAttachment`）。回退的裁切正是把这一行从投影里删掉：

```text
SessionPane.handleRewindHere
  ├─ 1. attachmentRead({ target: {rowId, entityId}, attachmentIndex })   ← 行还在，授权成立
  ├─ 2. dispatchCommand("editUserQuery", { restoreToInput: true })       ← 行被裁掉
  └─ 3. setComposerRestoreRequest({ attachments, attachmentPreviewUrls })
        └─ restoreSessionOwnedAttachments → objectUrl 落到 chip 上
```

第 1 步放到第 2 步之后，gateway 只能回 `fault.attachment.previewRefNotAuthorized`，图片就退化成文件图标。

## 接口

```ts
interface ComposerRestoreRequest {
  attachments: readonly AttachmentRef[];
  /** 与 attachments 同下标；缺席的项渲染成文件图标。 */
  attachmentPreviewUrls?: readonly (string | undefined)[];
}

restoreSessionOwnedAttachments(
  attachments: readonly AttachmentRef[],
  previewUrls?: readonly (string | undefined)[],
): boolean;
```

- `isPreviewableComposerMediaMime()`：只有 `image/*`、`video/*`、`application/pdf` 需要缩略图。
- `releaseAttachmentPreviewUrls()`：只 revoke `blob:`；Desktop 本地媒体 URL 由 host 管理。

## 时序与释放

1. 读失败或不是媒体时该下标为 `undefined`；整组都失败时不传 `attachmentPreviewUrls`。
   读取边界与对话里的缩略图一致（`PROTOCOL_V4_LIMITS.attachmentPreviewMaxBytes` / 分块上限），
   超限或切网失败同样降级为文件图标。
2. 命令被拒绝（`disposition: "blocked"` 或 ack 非 accepted）或抛错：当场 `releaseAttachmentPreviewUrls`，
   没有接收方。
3. 回填成功：object URL 的所有权转给 composer chip，由 `revokeChatComposerAttachment()` 在移除/发送后释放。

## 验收场景

- 消息 A 只有一张图，回退到 A：输入框里的图片 chip 显示缩略图，点开能预览，直接发送后又出现在对话里。
- 消息 A 有两张图 + 一个 pdf，回退到 A：两项都有缩略图，顺序与原文一致。
- 图片已被外部删除后再回退：回退成功，该 chip 显示文件图标，正文照常回填。
- 回退被「文件不安全」拦下：输入框不变，且不残留 object URL。
