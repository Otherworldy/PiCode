# Changelog

## [3.15.2](https://github.com/Otherworldy/PiCode/compare/v3.15.0...v3.15.2) (2026-10-14)

### Bug Fixes

* 固定手机远程控制端口 ([3338fc7](https://github.com/Otherworldy/PiCode/commit/3338fc704e7887649e6e59932fbdcc6b69277c58))

* 装 git 插件前先清掉半截检出目录 ([c3d78b9](https://github.com/Otherworldy/PiCode/commit/c3d78b9cd9ed52dc4cd0e3a63a6395bae4e69343))

## [3.15.0](https://github.com/Otherworldy/PiCode/compare/v3.14.14...v3.15.0) (2026-10-14)

### Features

* 在输入框上方显示 Plannotator 待办抽屉 ([1a393c9](https://github.com/Otherworldy/PiCode/commit/1a393c9474bfcb23e39db88a3de30aef19d7bc4a))

* 增加 UI 设计模式，审查等待时保留意见气泡和停止键 ([68d9c08](https://github.com/Otherworldy/PiCode/commit/68d9c08f1c03cc3d3fc0739053456138e0e7d338))


### Bug Fixes

* 把待办抽屉改成待发信息同款顶条 ([5354ae5](https://github.com/Otherworldy/PiCode/commit/5354ae53100cb27d8523a936036c67926b2d6408))

* 用户范围的 Pi 插件更新缓存改为全局一份 ([dd3eba3](https://github.com/Otherworldy/PiCode/commit/dd3eba3e5f94ca505f256d7839870866e43ecdc4))

## [3.14.14](https://github.com/Otherworldy/PiCode/compare/v3.14.13...v3.14.14) (2026-10-13)

### Features

* 把审查页交给内置浏览器，并纳入项目提示词与手机远控 ([3d3818e](https://github.com/Otherworldy/PiCode/commit/3d3818e743d82e1f14cd1aa054e70f9150f6fceb))

## [3.14.13](https://github.com/Otherworldy/PiCode/compare/v3.14.12...v3.14.13) (2026-10-13)

### Features

* 让手机挂到当前窗口并远程控制会话 ([f6ee26f](https://github.com/Otherworldy/PiCode/commit/f6ee26f2c91d54f776df600d15e02c0f14120c8a))


### Bug Fixes

* 把手机远程控制改成设置旁的图标 ([db14218](https://github.com/Otherworldy/PiCode/commit/db1421801ad0a6c6002383bac1d65f1d83240109))


### Refactorings

* 删除移动端bot相关功能 ([92be239](https://github.com/Otherworldy/PiCode/commit/92be239804fb7c100f9eb95702136ab0cfddc9fb))

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
