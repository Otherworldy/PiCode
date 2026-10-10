# PiCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="PiCode" width="128" height="128" />
</div>

<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

PiCode 是 AI 编程工作台。打开一个项目，在桌面应用或浏览器里和 Agent 一起读代码、改文件、运行命令。每次工具调用都留在会话里。

## 能做什么

- **桌面应用。** 用 Electron 打开本地项目，在会话里和 Agent 协作。
- **浏览器。** 同一套工作台跑在浏览器里，本机起一个页面就能用。
- **终端。** `zcode` 不带参数时打印帮助。`zcode --web` 在本机打开浏览器工作台，不需要 Electron。桌面和浏览器里的 Agent 都由这套运行时提供。

Git、会话和插件跟着当前项目走。

## 开始

需要 Git、Node.js **24.14.0** 和 pnpm **10.33.2**。版本以 [mise.toml](mise.toml) 为准。命令都在仓库根目录执行。

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` 安装依赖并准备本地运行资源。`pnpm dev:desktop` 启动桌面应用。

只看浏览器和后端时：

```bash
pnpm dev:web
```

打开 <http://localhost:5173>。背后的服务在 <http://localhost:3030>。

<a id="zcode-命令行版"></a>

装好或构建出命令行包之后，在项目目录里可以：

```bash
zcode --web
```

不带参数的 `zcode` 只打印帮助。

## 源码在哪

| 目录 | 内容 |
| --- | --- |
| `packages/desktop` | 桌面应用 |
| `packages/web`、`packages/server` | 浏览器界面和本地服务 |
| `packages/ui` | 桌面和浏览器共用的界面 |
| `apps/zcode-cli` | Agent 命令行和运行时 |

## 许可

本仓库代码采用 [Apache-2.0](LICENSE)。PiCode 基于智谱开源的 [ZCode](https://github.com/zai-org/ZCode) 继续开发。功能边界、数据风险和第三方声明见 [NOTICE.md](NOTICE.md)。
