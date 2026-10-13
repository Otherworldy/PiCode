# Changelog

## [3.14.12](https://github.com/Otherworldy/PiCode/compare/v3.14.11...v3.14.12) (2026-10-13)

### Bug Fixes

* 收紧会话资源并修正启动、Git 和标题回写 ([d8634b2](https://github.com/Otherworldy/PiCode/commit/d8634b20a5a86602d244e7c72045ef40dee14c56))
  * 内置 Pi SDK 升到 1.2.0，chrome-devtools 改为点名后才连接
  * 启动只预热当前工作区，不再为最近项目拉起空的 app-server
  * HTTP 204 不再把空响应体交给 Response，避免打崩 app-server
  * Git 命令串行执行，超时杀掉整棵进程树；文件监听忽略 node_modules
  * 重放会话时不把总结标题盖回首条原文
  * 插件安装失败时保留命令的错误输出

## [3.14.11](https://github.com/Otherworldy/PiCode/compare/v3.14.10...v3.14.11) (2026-10-12)

### Features

* highlight top-right update button and add plugin prerequisites notice ([65a6f5a](https://github.com/Otherworldy/PiCode/commit/65a6f5ac9f3224ba13d3ec195aa2f042c3816785))

## [3.14.10](https://github.com/Otherworldy/PiCode/compare/v3.14.9...v3.14.10) (2026-10-12)

### Features

* add the Pi plugin market and land today's session work ([336127c](https://github.com/Otherworldy/PiCode/commit/336127c24be33869f46a1ef1d1c9285dd6c49d61))

## [3.14.9](https://github.com/Otherworldy/PiCode/compare/v3.14.8...v3.14.9) (2026-10-11)

### Bug Fixes

* keep tools on conversation branches and restore fork controls ([fa746d9](https://github.com/Otherworldy/PiCode/commit/fa746d9fe98b33b0f788c7dc9981ae05c1a1a558))

* write GitHub release notes from the commits since the last tag ([e95dedf](https://github.com/Otherworldy/PiCode/commit/e95dedf933e37cb74ffcebc573cfd1b961ea936f))
