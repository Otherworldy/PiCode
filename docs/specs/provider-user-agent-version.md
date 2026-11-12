# 上游请求头里的 Pi 版本

## 背景

主会话请求由 `@picode/pi-host` 内的 Pi `AgentSession` 发出，`User-Agent` 由 pi-ai 拼装
（`pi-ai/dist/utils/identity.js`）：

```
pi/<version> (<platform>; node/v<node>; <arch>)
```

`<version>` 不是 PiCode 版本，而是 Pi 自己的 `VERSION`
（`pi-coding-agent/dist/config.js:493`，`pkg.version || "0.0.0"`），`pkg` 是 Pi 启动时
**沿 `import.meta.url` 向上找到的第一个 `package.json`**。

单文件 `zcode.cjs` 里，build 的 `createCjsImportMetaUrlPlugin` 把 `import.meta.url`
改写成 bundle 自身路径，于是 Pi 从 bundle 所在目录向上找：

| 形态              | bundle 位置                                   | 找到的 `package.json`                                  | UA         |
| ----------------- | --------------------------------------------- | ------------------------------------------------------ | ---------- |
| 桌面 dev / 未打包 | `packages/desktop/bundled-agents/<平台>/glm/` | `packages/desktop/package.json`，**无 `version` 字段** | `pi/0.0.0` |
| 安装包            | `<install>/resources/glm/`                    | 一路到盘根都没有，`pkg` 为空对象                       | `pi/0.0.0` |
| SEA               | 可执行文件旁                                  | 同上                                                   | `pi/0.0.0` |

`bootstrap/src/model-config.ts` 里的 `User-Agent: PiCode/<appVersion>` 属于
`@picode/adapters` 的 runner 链路（辅助生成类调用），不经过 Pi `AgentSession`，无法覆盖它。

## 规则

1. build 阶段改写 Pi 的版本声明，把 `VERSION` 钉到构建时读到的内置 Pi 版本：

   ```js
   export const VERSION = globalThis.__zcodeBundledPiVersion || pkg.version || "0.0.0";
   ```

   `globalThis.__zcodeBundledPiVersion` 由 `zcode.cjs` 的 banner 在 Agent 初始化之前写入
   （值与 `pi-host/src/pi-sdk.ts` 展示用的一致），因此 `config.js` 顶层求值时已可用。

2. 不能改用 esbuild 的 `define: { VERSION }`：`VERSION` 在模块作用域已由
   `export const` 声明，esbuild 对本地声明不做 `define` 替换（实测未生效）。

3. 改写找不到原声明时构建失败并报出该文件路径。Pi 若改了实现，必须当场暴露，
   不允许静默退回 `0.0.0`。

4. 只在 `@earendil-works/pi-coding-agent/dist/config.js` 上改写。`dist/bundle/chunks/`
   那份是 Pi 自带的预打包产物，PiCode 不经该入口。

## 不做的事

- 不覆盖 pi-ai 的 identity、不加 `before_provider_headers` 扩展去改 UA，
  也不把 UA 换成 `PiCode/<appVersion>`：上报的身份应当如实反映实际跑的 Pi。
- 不在 `bundled-agents/` 里塞一份伪造的 `package.json`：那会同时改变 Pi 的
  `APP_NAME` / `PACKAGE_NAME` 等其它派生值，且 CLI 直跑、SEA 三条路径都得各写一份。

## 验证方式

- 构建后 `zcode.cjs` 中该声明形如
  `Sl=globalThis.__zcodeBundledPiVersion||hwe.version||"0.0.0"`。
- 抓一条上游请求：`User-Agent` 从 `pi/0.0.0 (win32; node/v24.x; x64)` 变成
  `pi/<内置 Pi 版本> (...)`，平台与 Node 段不变。
- 源码直跑（`pnpm --filter @picode/cli dev`，tsx 加载真实 Pi 包）时 `VERSION` 仍来自
  真实 `package.json`，两条路径的 UA 版本一致。
