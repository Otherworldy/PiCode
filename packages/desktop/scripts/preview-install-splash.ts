/**
 * 手工预览「安装中」小窗，用于验证视觉与自动关闭，不触发真实更新。
 *
 *   pnpm exec tsx packages/desktop/scripts/preview-install-splash.ts [--dark] [--en] [--fail] [--process <name>]
 *
 * 小窗靠「旧实例全部退出后出现带主窗口的新同名进程」判定安装结束。默认进程名是
 * notepad，所以：先用记事本开一个窗口，再跑本脚本，然后关掉那个记事本、重新开一个，
 * 小窗应当自动消失——这就是真实安装完成后应用被重新拉起的那一步。
 *
 * 这里直接从当前 console 拉起 powershell；生产路径必须经 `cmd /c start`，因为 Electron
 * 主进程没有 console（直接 spawn 会让 powershell 开局就退）。该契约由 installSplash 的
 * 单测钉住，预览只负责看观感。
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { buildInstallSplashScript } from "../src/main/appUpdate/installSplash.ts";
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const flagValue = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const processName = flagValue("process", "notepad");
// 有构建产物就用真实应用图标，否则退回当前 node 图标（只影响预览观感）。
const packagedExe = fileURLToPath(new URL("../dist/win-unpacked/PiCode.exe", import.meta.url));
const appIconPath = existsSync(packagedExe) ? packagedExe : process.execPath;
let script = buildInstallSplashScript({
  appProcessName: processName,
  appIconPath,
  latestVersion: "v0.0.0-preview",
  locale: hasFlag("en") ? "en-US" : "zh-CN",
});
if (hasFlag("dark")) {
  // 预览用：把「跟随系统主题」换成固定深色，不必改系统设置。
  script = script.replace(
    "if ($theme -and $theme.AppsUseLightTheme -eq 1) { $light = 1 }",
    "$light = 0",
  );
}
if (hasFlag("fail")) {
  // 预览失败态：把 8 分钟超时压成立即到期。
  script = script.replace("$startedAt.AddMinutes(8)", "$startedAt.AddMinutes(0)");
}

const scriptPath = join(tmpdir(), "PiCode-update-splash-preview.ps1");
writeFileSync(scriptPath, `\uFEFF${script}`, "utf8");
console.log(`preview script: ${scriptPath}`);
console.log(`检测的进程名: ${processName}`);
console.log("关闭方式：点窗口右上角 ×，或关掉/重开一个同名进程窗口。");

const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
  { stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 0));
