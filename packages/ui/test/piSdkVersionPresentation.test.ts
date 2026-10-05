import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodePiSdkStatus } from "@zcode/shared";
import { resolvePiSdkVersionPresentation } from "../src/settings/PiSdkSourceSetting.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";

function createMockIntl(messages: Record<string, string>) {
  return {
    formatMessage(descriptor: { id: string }, values?: Record<string, string | number>) {
      let message = messages[descriptor.id] ?? descriptor.id;
      if (values) {
        for (const [key, val] of Object.entries(values)) {
          message = message.replaceAll(`{${key}}`, String(val));
        }
      }
      return message;
    },
  };
}

test("未加载完成时优雅降级，不展示版本后缀", () => {
  const intl = createMockIntl(zhCN);
  const result = resolvePiSdkVersionPresentation({
    status: undefined,
    source: "builtin",
    intl,
  });

  assert.equal(result.activeVersion, undefined);
  assert.equal(result.detail, "");
  assert.equal(result.builtinLabel, "内置");
  assert.equal(result.globalLabel, "全局安装");
});

test("默认使用内置 SDK 时展示内置版本号和对应文案", () => {
  const intlZh = createMockIntl(zhCN);
  const status: ZCodePiSdkStatus = {
    requested: "builtin",
    active: "builtin",
    builtinVersion: "1.0.2",
  };
  const resultZh = resolvePiSdkVersionPresentation({
    status,
    source: "builtin",
    intl: intlZh,
  });

  assert.equal(resultZh.activeVersion, "1.0.2");
  assert.equal(resultZh.detail, "当前使用内置 Pi 1.0.2。");
  assert.equal(resultZh.builtinLabel, "内置 (v1.0.2)");
  assert.equal(resultZh.globalLabel, "全局安装");

  const intlEn = createMockIntl(enUS);
  const resultEn = resolvePiSdkVersionPresentation({
    status,
    source: "builtin",
    intl: intlEn,
  });
  assert.equal(resultEn.activeVersion, "1.0.2");
  assert.equal(resultEn.detail, "Using built-in Pi 1.0.2.");
  assert.equal(resultEn.builtinLabel, "Built-in (v1.0.2)");
});

test("使用全局 SDK 时展示全局版本号和对应文案", () => {
  const intl = createMockIntl(zhCN);
  const status: ZCodePiSdkStatus = {
    requested: "global",
    active: "global",
    builtinVersion: "1.0.2",
    globalVersion: "1.0.5",
  };
  const result = resolvePiSdkVersionPresentation({
    status,
    source: "global",
    intl,
  });

  assert.equal(result.activeVersion, "1.0.5");
  assert.equal(result.detail, "当前使用全局 Pi 1.0.5。");
  assert.equal(result.builtinLabel, "内置 (v1.0.2)");
  assert.equal(result.globalLabel, "全局安装 (v1.0.5)");
});

test("切换后尚未重启时保持展示当前生效版本并给出待重启提示", () => {
  const intl = createMockIntl(zhCN);
  const status: ZCodePiSdkStatus = {
    requested: "builtin",
    active: "builtin",
    builtinVersion: "1.0.2",
  };
  const result = resolvePiSdkVersionPresentation({
    status,
    source: "global",
    intl,
  });

  assert.equal(result.activeVersion, "1.0.2");
  assert.equal(result.detail, "当前进程还是切换前的 SDK，重启后才会换成新选择。");
});

test("全局包缺失时回退内置版本并提示缺失", () => {
  const intl = createMockIntl(zhCN);
  const status: ZCodePiSdkStatus = {
    requested: "global",
    active: "builtin",
    builtinVersion: "1.0.2",
    reason: "missing",
  };
  const result = resolvePiSdkVersionPresentation({
    status,
    source: "global",
    intl,
  });

  assert.equal(result.activeVersion, "1.0.2");
  assert.equal(result.detail, "没有找到全局 Pi，这次仍使用内置 SDK。");
});

test("全局包不兼容时回退内置版本并提示版本差异", () => {
  const intl = createMockIntl(zhCN);
  const status: ZCodePiSdkStatus = {
    requested: "global",
    active: "builtin",
    builtinVersion: "1.0.2",
    globalVersion: "1.1.0",
    reason: "incompatible",
  };
  const result = resolvePiSdkVersionPresentation({
    status,
    source: "global",
    intl,
  });

  assert.equal(result.activeVersion, "1.0.2");
  assert.equal(result.detail, "全局 Pi 1.1.0 与内置 1.0.2 的主次版本不一致，这次仍使用内置 SDK。");
  assert.equal(result.globalLabel, "全局安装 (v1.1.0)");
});
