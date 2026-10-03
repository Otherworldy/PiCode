# 工作区文件搜索忽略

`.picodeignore`（workspace 根目录，gitignore 语法）是 @ 候选、Command Center、文件树搜索的唯一忽略规则。不影响 git、文件树浏览、上传或 Agent 读文件。

## 所有权

| 状态                         | 所有者                             |
| ---------------------------- | ---------------------------------- |
| 搜索忽略规则正文             | workspace 根目录的 `.picodeignore` |
| 读取、缺失时创建、设置页读写 | `workspaceFileIgnore.ts`           |

`fileService` 只消费解析后的规则与该文件的 mtime/size 指纹，不另存一份规则。

## 迁移

只在 `.picodeignore` 不存在且 `.zcodeignore` 存在时，把旧文件 `rename` 为 `.picodeignore`。两者都在时保留新文件，不覆盖、不删除旧文件。`rename` 失败（占用或权限）则继续读旧路径，不另写一份模板把自定义规则盖掉。下次加载会再试一次改名。

## 失败

读或创建失败时，内存中改用 `.gitignore`，再失败用内置默认规则。搜索不因此失败。

## 验收

1. 只有 `.zcodeignore` 时，读取后磁盘上变为 `.picodeignore`，内容不变，旧文件消失。
2. 两者都在时，读到的是 `.picodeignore`，`.zcodeignore` 仍在且内容不变。
3. 都没有时，扫描创建 `.picodeignore`，不创建 `.zcodeignore`。
