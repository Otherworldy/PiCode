# PiCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="PiCode" width="128" height="128" />
</div>

<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

PiCode is an AI coding workspace. Open a project and work with an agent in the desktop app or the browser: read code, edit files, and run commands. Each tool call stays in the session.

## What it does

- **Desktop.** An Electron app for opening a local project and working with the agent in a session.
- **Browser.** The same workspace in a browser. Start it locally and open one page.
- **Terminal.** `zcode` with no arguments prints help. `zcode --web` opens the browser workspace on this machine, without Electron. The desktop and browser agents use this same runtime.

Git, sessions, and plugins follow the current project.

## Start

You need Git, Node.js **24.14.0**, and pnpm **10.33.2**. Versions come from [mise.toml](mise.toml). Run the commands from the repository root.

```bash
pnpm bootstrap
pnpm dev:desktop
```

`pnpm bootstrap` installs dependencies and prepares local runtime assets. `pnpm dev:desktop` starts the desktop app.

For the browser and backend only:

```bash
pnpm dev:web
```

Open <http://localhost:5173>. The service behind it listens on <http://localhost:3030>.

After the command-line package is installed or built, from a project directory:

```bash
zcode --web
```

`zcode` with no arguments only prints help.

## Where the code is

| Directory | Contents |
| --- | --- |
| `packages/desktop` | Desktop app |
| `packages/web`, `packages/server` | Browser UI and local service |
| `packages/ui` | UI shared by desktop and browser |
| `apps/zcode-cli` | Agent CLI and runtime |

## License

The code in this repository is [Apache-2.0](LICENSE). PiCode continues from Zhipu's open-source [ZCode](https://github.com/zai-org/ZCode). See [NOTICE.md](NOTICE.md) for feature boundaries, data risks, and third-party notices.
