import { describe, expect, it, vi } from "vitest";
import { buildInstallSplashScript, showInstallSplash } from "./installSplash.js";

describe("install splash", () => {
  it("shows the target version and polls the app executable", () => {
    const script = buildInstallSplashScript({
      appProcessName: "PiCode",
      latestVersion: "v3.18.0",
      locale: "zh-CN",
    });
    expect(script).toContain("'正在安装 PiCode 3.18.0'");
    expect(script).toContain("Get-Process -Name 'PiCode'");
    // 判定安装结束靠「旧实例先退完、新进程带主窗口」，以免退出瞬间的同名子进程提前关窗。
    expect(script).toContain("$known = @(Get-Process");
    expect(script).toContain("if ($old.Count -eq 0 -and $fresh.Count -gt 0)");
    // IntPtr 不是 IComparable，只能 ToInt64 后比大小；$null 比较会把取值失败当成「有窗口」。
    expect(script).toContain("$_.MainWindowHandle.ToInt64() -gt 0");
  });

  it("draws its own card instead of the WinForms default chrome", () => {
    const script = buildInstallSplashScript({
      appProcessName: "PiCode",
      latestVersion: "3.18.0",
      locale: "zh-CN",
    });
    // 默认 WinForms 外观与应用完全不像：自绘圆角卡片 + 跟随系统深浅色 + 品牌色进度条。
    expect(script).toContain("$form.FormBorderStyle = 'None'");
    expect(script).toContain("AppsUseLightTheme");
    expect(script).toContain("FromHtml('#E6A23C')");
    expect(script).toContain("$form.Region = New-Object System.Drawing.Region($shape)");
    expect(script).toContain("Microsoft YaHei UI");
    // 不常驻置顶：出现时临时抬一次拿到前台，随即降回普通窗口。
    const shown = script.indexOf("$form.Show()");
    const raised = script.indexOf("$form.TopMost = $true");
    const dropped = script.indexOf("$form.TopMost = $false");
    expect(raised).toBeGreaterThan(shown);
    expect(dropped).toBeGreaterThan(raised);
  });

  it("uses the app executable icon so the taskbar does not show powershell", () => {
    const script = buildInstallSplashScript({
      appProcessName: "PiCode",
      appIconPath: "C:/Program Files/PiCode/PiCode.exe",
      locale: "zh-CN",
    });
    expect(script).toContain("ExtractAssociatedIcon('C:/Program Files/PiCode/PiCode.exe')");
    expect(script).toContain("if ($appIcon) { $form.Icon = $appIcon }");
    // 没有图标路径时不能凭空引用未定义变量。
    expect(buildInstallSplashScript({ appProcessName: "PiCode", locale: "zh-CN" })).not.toContain(
      "ExtractAssociatedIcon",
    );
  });

  it("keeps the timeout, the window grace and the failure hold bounded", () => {
    const script = buildInstallSplashScript({ appProcessName: "PiCode", locale: "zh-CN" });
    expect(script).toContain("$startedAt.AddMinutes(8)");
    expect(script).toContain(".TotalSeconds -gt 60) { break }");
    expect(script).toContain("$holdUntil = (Get-Date).AddMinutes(2)");
  });

  it("generates balanced PowerShell blocks", () => {
    const script = buildInstallSplashScript({
      appProcessName: "PiCode",
      latestVersion: "3.18.0",
      locale: "zh-CN",
    });
    expect(script.split("{").length).toBe(script.split("}").length);
    expect(script.split("(").length).toBe(script.split(")").length);
  });

  it("falls back to English copy and still renders without a version", () => {
    const script = buildInstallSplashScript({ appProcessName: "PiCode", locale: "en-US" });
    expect(script).toContain("'Installing PiCode'");
    expect(script).toContain("'Update did not finish'");
    expect(script).not.toContain("正在安装");
  });

  it("escapes quotes and newlines so PowerShell keeps one string", () => {
    const script = buildInstallSplashScript({
      appProcessName: "Pi'Code",
      latestVersion: "3.18.0'\r\nAdd-Type -AssemblyName evil",
      locale: "en-US",
    });
    expect(script).toContain("Get-Process -Name 'Pi''Code'");
    expect(script).toContain("Installing PiCode 3.18.0'' Add-Type -AssemblyName evil'");
    expect(script).not.toContain("\r\nAdd-Type -AssemblyName evil");
  });

  it("writes a BOM-prefixed script and detaches powershell outside the install dir", async () => {
    const writeFileImpl = vi.fn(async () => undefined);
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref }));

    await showInstallSplash({
      scriptPath: "C:/tmp/PiCode-update-splash.ps1",
      appProcessName: "PiCode",
      locale: "zh-CN",
      writeFileImpl,
      spawnImpl,
    });

    const [path, data] = writeFileImpl.mock.calls[0] as unknown as [string, string];
    expect(path).toBe("C:/tmp/PiCode-update-splash.ps1");
    // PowerShell 5.1 没有 BOM 会按 ANSI 解码，中文文案会变成乱码。
    expect(data.startsWith("\uFEFF")).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(
      "cmd.exe",
      [
        "/c",
        "start",
        "",
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
        "C:/tmp/PiCode-update-splash.ps1",
      ],
      // 必须经 cmd/start 让 powershell 拿到 console（Electron 主进程没有，直接 spawn 会秒退）；
      // cwd 留在临时目录：进程 cwd 会持有目录句柄，拦住安装器删安装目录。
      { stdio: "ignore", windowsHide: true, cwd: "C:/tmp" },
    );
    expect(unref).toHaveBeenCalledOnce();
  });
});
