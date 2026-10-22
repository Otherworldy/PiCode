# 子智能体工具覆盖

设置页「子智能体」可以为内置的 7 个角色（`scout`、`researcher`、`evidence-auditor`、`worker`、`reviewer`、`oracle`、`delegate`）配置启用哪些工具。用户级、项目级、插件代理不走这条：它们的 Markdown / 插件清单本来就带 `tools`，由各自的编辑入口维护。

## 所有权与存储

唯一所有者是 `<storageRoot>/v2/agents-state.json` 的 `builtInToolOverrides`：角色名 → 覆盖对象。模型覆盖 `builtInModelSelectionOverrides`、禁用列表 `disabledAgentIds` 同一文件、同一写队列（`subagentsService` 的 `writeQueue`）。

```json
{
  "builtInToolOverrides": { "researcher": { "tools": ["read", "one_search"] }, "worker": "inherit" }
}
```

- 没有这个 key = 继承角色默认工具（`packages/shared/src/builtin-subagents.ts` 的 `tools`）。
- `tools` 三种取值：省略 = 角色默认；`"inherit"` = 全部 Pi 内置工具；数组（可为空）= 白名单。**空数组是有效值，表示无工具**；删除覆盖要传 `tools: null`。
- `excludeTools` 在 `tools` 解析之后做减法。显式数组在设置页投影与 `normalizeAgentProfiles` 里就直接减完；`"inherit"` 保留 `tools: ["*"]` 与 `toolsExclude`，到 Pi 白名单那一层再减。
- 工具名用 Pi 的名字（小写，如 `read`、`one_search`、`web_fetch`）。Pi 原名按精确名收口：勾了 `bash` 就只声明 `bash`，不会因为别名展开又带上 `powershell`；Claude 风格名（`Bash`、`WebSearch` 等）仍按别名表展开，供用户/项目代理沿用。
- 非 7 个角色的名字直接拒绝，不写盘。
- 内置角色仍然 `readOnly: true`：覆盖不写角色 Markdown，也不改任何用户/项目代理文件。

## 读写两侧

设置页投影与运行时读同一份状态文件，各自解析，互不代写：

| 侧                | 入口                                                                                                 | 结果                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 设置页            | `subagentsService.list()` → `createBuiltInAgents`                                                    | `tools` 是生效列表（`["*"]` 表示全部内置）；有覆盖时带 `toolsOverride`，inherit 时另带 `toolsExclude` |
| `picode_subagent` | `bootstrap` 的 `loadZCodeAgentProfiles` → `pi-capabilities.listSubagents` → `normalizeAgentProfiles` | 覆盖替换角色默认 `tools`，再交给 `piToolNamesForAgent` 收口成 Pi 白名单                               |
| core runtime      | `loadZCodeAgentProfiles` → `runtimeConfig.subagents.builtInToolOverrides` → `normalizeAgentProfiles` | 同上                                                                                                  |

`builtInToolOverrides` 的解析只在 `parseBuiltInSubagentToolOverrides`（shared）里做一次规则定义：只接受 7 个角色名，接受覆盖对象或早期的裸数组，逐条 trim、去重、丢非字符串。两个 reader 都调它，不得各自补默认值。

## 子会话的工具与扩展

`runZcodeSubagent` 按角色声明的工具名决定加载什么：

1. 把 `tools` 解析成 Pi 实际工具名（原名精确、别名展开、`*`/`inherit` 无目标）。
2. 其中非 Pi 内置的名字视为扩展工具，用 `listPiAgentExtensions(cwd)` 反查哪个扩展注册了它，只把命中的扩展入口以 `file://` URL 放进 `additionalExtensionPaths`，同时 `noExtensions: true`。没有扩展工具时一个包都不加载。只在 `session_start` / `resources_discover` 里注册工具的扩展反查不到，这是这条窄加载的已知边界：覆盖里点名的工具会直接报缺失，角色默认里的工具则被静默裁剪。
3. 加载后子会话显式发 `session_start` 并调 `bindExtensions`，让这些扩展注册请求期 hook；结束前先发 `session_shutdown` 再 `dispose()`。
4. 设置页覆盖里显式列出的扩展工具在解析后仍找不到 provider 时直接失败（`subagent failed: tools not available: ...`）；内置工具的平台差异与角色默认缺失只静默裁剪（否则没装 web 插件的用户所有内置角色都起不来），用户/项目/插件角色维持原有的静默裁剪。

白名单（`tools`）仍然是声明面的唯一入口：未列出的工具不会被声明给模型，扩展自己调 `setActiveTools` 不在这个保证内。

扩展在子会话进程本地加载并执行；SSH 工作区只有内置读写工具走远端，扩展工具仍在本地。给 SSH 工作区的角色配工具时，别把只对远端有意义的扩展工具写进覆盖。

## 工具清单来源

内置角色编辑器里的候选项来自 agent 进程的运行时扫描，不是前端写死的列表：

`agents/toolCatalog` → `listPiAgentTools(cwd)` = Pi 内置工具（`source: "builtin"`）+ 用户 Pi 包扩展注册的工具（`source: "extension"`），去掉 `mcp__*`、`subagent`、`picode_subagent`，非 Windows 上再去掉 `powershell`（Pi 无条件注册它，但本机执行必然失败；`piLocalToolNames` 同步把它排除在可声明集外，所以跨平台的旧覆盖也不会生效）。

设置页可能没有活动会话，所以清单按 workspace 现扫（照 `skills/referenceCatalog` 的先例），不读会话快照，也不带 `sessionId`。内置表单没有工作区选择器，扫描用的是当前选中的工作区（用户页默认取第一个已连接的工作区），所以项目级 `packages` 提供的工具名取决于这个工作区；覆盖本身是用户级全局的，对所有工作区生效。扫描用的 loader 与子会话一致：读文件里的 Pi 设置（global 与 project 两个 scope 的 `packages` 都算），不注册 codemode / tool-search / MCP 内置工厂。

清单拉取失败时，编辑器只展示当前生效的工具名并提示失败，不隐藏已有选择。

## 设置页交互

- 三种模式：角色默认（不写覆盖）、全部内置工具（`tools: "inherit"`，未勾选的写进 `excludeTools`）、自定义（`tools` 数组，至少留一个；空列表只可能来自手改状态文件）。
- 「恢复角色默认」清掉覆盖；「使用全部内置工具」切到 inherit 模式。
- 保存时模型覆盖与工具覆盖各写一次，走同一条写队列。

## 事件顺序

1. 用户在编辑表单里勾选工具，保存。
2. `setBuiltInToolOverride` 进写队列，串行写状态文件；模型覆盖仍在同一次保存里调 `setBuiltInModelOverride`。
3. 下一次 `picode_subagent` 调用时 `listSubagents` 重新读盘，新白名单与扩展加载立即生效，不需要重启会话。core runtime 的子代理端口在创建时归一化一次，覆盖要等新的 runtime 才生效；父会话提示词里的角色工具面在新建 runtime 后同步。

## 验收场景

- 覆盖 `researcher` 只留 `read` + `one_search`：子会话只声明这两个工具，`write` 与 `web_fetch` 都不出现，且只加载注册 `one_search` 的那个扩展。
- `tools: "inherit"` + `excludeTools: ["bash"]`：`normalizeAgentProfiles` 保留 `tools: ["*"]` 与 `toolsExclude`，`piToolNamesForAgent` 展开全部可用工具后减掉 `bash`。
- `tools: []`：子会话没有任何工具，启动照常。
- 清空覆盖：`tools` 回到角色默认（`read`、`write`、`one_search`、`web_fetch`、`get_search_content`、`source_check`）。
- 覆盖里显式列出的扩展工具在当前环境没有提供者：启动即失败并列出缺失工具名；角色默认里的扩展工具缺失只静默裁剪。
- 用户/项目/插件代理的 `tools` 不受影响，仍由各自文件决定。
- 工具清单接口失败：编辑器仍显示当前生效工具，保存照常写覆盖。
