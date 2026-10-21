import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** 安装超过这个时间仍未拉起新应用，视为本次更新失败并给出可见提示。 */
const SPLASH_TIMEOUT_MINUTES = 8;
/** 失败提示保留时长；用户可手动关闭，超时也会自己退出，不留置顶窗口。 */
const SPLASH_FAILURE_HOLD_MINUTES = 2;
/** 新进程已经出现但还没有主窗口时，最多再等这么久。 */
const SPLASH_WINDOW_GRACE_SECONDS = 60;

interface SplashCommand {
  unref(): void;
}

export interface ShowInstallSplashOptions {
  /** 不是自己的一部分：写在 %TEMP%，安装器覆盖安装目录时不会碰到它。 */
  scriptPath: string;
  /** 安装结束后会被安装器重新拉起的可执行文件名，用于判断安装已完成。 */
  appProcessName: string;
  /** 当前应用的可执行文件：用它的图标当窗口/任务栏图标。 */
  appIconPath?: string;
  latestVersion?: string;
  locale?: string;
  writeFileImpl?: (path: string, data: string) => Promise<void>;
  spawnImpl?: (
    command: string,
    args: string[],
    spawnOptions: { stdio: "ignore"; windowsHide: boolean; cwd: string },
  ) => SplashCommand;
}
/**
 * 静默安装期间唯一可见的窗口。
 *
 * 应用必须退出才能让安装器替换文件，`/S` 安装器又不画任何界面，所以这里用一个
 * 与安装目录无关的系统进程顶住这段空白期：它只读进程列表，不碰安装目录里的文件。
 * 工作目录也要离开安装目录：Windows 上 cwd 会持有目录句柄，拦住安装器删目录。
 */
export async function showInstallSplash(options: ShowInstallSplashOptions): Promise<void> {
  // Windows PowerShell 5.1 默认按 ANSI 读取脚本，中文文案必须带 BOM 才会被正确解码。
  await (options.writeFileImpl ?? ((path, data) => writeFile(path, data, "utf8")))(
    options.scriptPath,
    `\uFEFF${buildInstallSplashScript(options)}`,
  );
  // 必须经 `cmd /c start` 拉起：powershell.exe 需要 console，而 Electron 主进程没有，
  // 直接 spawn（含 detached / windowsHide）它在窗口出现前就退了。start 会给它新建一个
  // console，再由 `-WindowStyle Hidden` 藏起来；cmd 自己立刻退出，powershell 变成孤儿进程，
  // 应用 quit 不会带走它。实测：父进程无 console 时仍能显示窗口并活到安装结束。
  const child = (options.spawnImpl ?? spawn)(
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
      options.scriptPath,
    ],
    { stdio: "ignore", windowsHide: true, cwd: dirname(options.scriptPath) },
  );
  child.unref();
}

export function buildInstallSplashScript(options: {
  appProcessName: string;
  appIconPath?: string;
  latestVersion?: string;
  locale?: string;
}): string {
  const zh = (options.locale ?? "").toLowerCase().startsWith("zh");
  const version = options.latestVersion?.trim().replace(/^v/i, "");
  const text = zh
    ? {
        caption: "PiCode 更新",
        title: version ? `正在安装 PiCode ${version}` : "正在安装 PiCode",
        hint: "安装完成后会自动打开 PiCode，请勿结束安装程序。",
        waited: "已等待 {0} 秒",
        failedTitle: "更新未完成",
        failedHint: "安装可能被中断，请手动启动 PiCode，或点击右上角关闭本窗口。",
      }
    : {
        caption: "PiCode Update",
        title: version ? `Installing PiCode ${version}` : "Installing PiCode",
        hint: "PiCode opens again automatically. Do not stop the installer.",
        waited: "Elapsed {0}s",
        failedTitle: "Update did not finish",
        failedHint: "The installer may have been interrupted. Start PiCode or close this window.",
      };
  const processName = psQuote(options.appProcessName);
  const waitedPrefix = psQuote(text.waited.split("{0}")[0] ?? "");
  const waitedSuffix = psQuote(text.waited.split("{0}")[1] ?? "");
  // 中文界面用雅黑，英文界面用 Segoe UI；两者都缺时 WinForms 会回退系统字体。
  const font = psQuote(zh ? "Microsoft YaHei UI" : "Segoe UI");

  // 默认 WinForms 外观和应用完全不像，这里整窗自绘成 card 浮层：圆角、跟随系统深浅色、
  // 品牌色 #E6A23C 的流动进度条。尺寸按 96 DPI 设计，系统缩放时由 DPI 虚拟化整体拉伸。
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$startedAt = Get-Date",
    "# 先记下旧实例：它退出后出现的同名进程才是安装器重新拉起的新版本。",
    `$known = @(Get-Process -Name ${processName} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)`,
    "",
    "# 跟随系统主题：浅色桌面上糊一块深色卡片同样突兀。",
    "$light = 0",
    "$theme = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name AppsUseLightTheme -ErrorAction SilentlyContinue",
    "if ($theme -and $theme.AppsUseLightTheme -eq 1) { $light = 1 }",
    "if ($light -eq 1) {",
    "  $cardColor = '#FFFFFF'; $borderColor = '#E4E4E4'; $titleColor = '#171717'",
    "  $subColor = '#7A7A7A'; $trackColor = '#ECECEC'",
    "} else {",
    "  $cardColor = '#232323'; $borderColor = '#3A3A3A'; $titleColor = '#F2F2F2'",
    "  $subColor = '#9E9E9E'; $trackColor = '#383838'",
    "}",
    "",
    `$titleText = ${psQuote(text.title)}`,
    `$subText = ${psQuote(text.hint)}`,
    `$footText = ${waitedPrefix} + '0' + ${waitedSuffix}`,
    "$failed = $false",
    "",
    `$titleFont = New-Object System.Drawing.Font(${font}, 15, [System.Drawing.FontStyle]::Bold)`,
    `$bodyFont = New-Object System.Drawing.Font(${font}, 9)`,
    `$smallFont = New-Object System.Drawing.Font(${font}, 8)`,
    "$titleBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($titleColor))",
    "$subBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($subColor))",
    "$trackBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml($trackColor))",
    "$accentBrush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#E6A23C'))",
    "$borderPen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml($borderColor), 1)",
    "$closePen = New-Object System.Drawing.Pen([System.Drawing.ColorTranslator]::FromHtml($subColor), 1.4)",
    "",
    "# 圆角卡片：窗口 Region 直接裁成同一条路径，不留系统标题栏。",
    "$width = 400",
    "$height = 132",
    "$radius = 10",
    "$shape = New-Object System.Drawing.Drawing2D.GraphicsPath",
    "$shape.AddArc(0, 0, $radius * 2, $radius * 2, 180, 90)",
    "$shape.AddArc($width - $radius * 2, 0, $radius * 2, $radius * 2, 270, 90)",
    "$shape.AddArc($width - $radius * 2, $height - $radius * 2, $radius * 2, $radius * 2, 0, 90)",
    "$shape.AddArc(0, $height - $radius * 2, $radius * 2, $radius * 2, 90, 90)",
    "$shape.CloseFigure()",
    "",
    "$form = New-Object System.Windows.Forms.Form",
    `$form.Text = ${psQuote(text.caption)}`,
    "$form.FormBorderStyle = 'None'",
    "$form.StartPosition = 'CenterScreen'",
    "# 不常驻置顶：用户切到其他窗口后就不该再被进度卡遮住，只能从任务栏找回。",
    "$form.ShowInTaskbar = $true",
    "$form.ClientSize = New-Object System.Drawing.Size($width, $height)",
    "$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml($cardColor)",
    "$form.Region = New-Object System.Drawing.Region($shape)",
    "$form.GetType().GetProperty('DoubleBuffered', [System.Reflection.BindingFlags]'Instance,NonPublic').SetValue($form, $true)",
    "# 不给图标时任务栏会显示 powershell.exe 的 logo；只读一次 exe 图标，不留句柄。",
    ...(options.appIconPath
      ? [
          "$appIcon = $null",
          `try { $appIcon = [System.Drawing.Icon]::ExtractAssociatedIcon(${psQuote(options.appIconPath)}) } catch { }`,
          "if ($appIcon) { $form.Icon = $appIcon }",
        ]
      : []),
    "",
    "$form.Add_Paint({",
    "  param($sender, $e)",
    "  $g = $e.Graphics",
    "  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias",
    "  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit",
    "  $g.DrawPath($borderPen, $shape)",
    "  $g.DrawString($titleText, $titleFont, $titleBrush, 20, 16)",
    "  $g.DrawString($subText, $bodyFont, $subBrush, 20, 50)",
    "  $g.FillRectangle($trackBrush, 20, 82, 360, 4)",
    "  if (-not $failed) {",
    "    $phase = (((Get-Date) - $startedAt).TotalMilliseconds % 1800) / 1800",
    "    $left = [int](20 - 110 + $phase * 470)",
    "    $right = $left + 110",
    "    if ($left -lt 20) { $left = 20 }",
    "    if ($right -gt 380) { $right = 380 }",
    "    if ($right -gt $left) { $g.FillRectangle($accentBrush, $left, 82, $right - $left, 4) }",
    "  }",
    "  $g.DrawString($footText, $smallFont, $subBrush, 20, 100)",
    "  $g.DrawLine($closePen, 369, 18, 381, 30)",
    "  $g.DrawLine($closePen, 381, 18, 369, 30)",
    "})",
    "",
    "$form.Add_MouseClick({",
    "  param($sender, $e)",
    "  if ($e.X -ge 360 -and $e.Y -le 44) { $sender.Close() }",
    "})",
    "",
    "$form.Show()",
    "# 后台进程的 Activate() 抢不到前台，先临时 topmost 抬一次再降回去：只需出现时被看到，",
    "# 之后就是普通窗口。否则应用退出后卡片会埋在别的窗口后面。",
    "$form.TopMost = $true",
    "$form.Activate()",
    "$form.TopMost = $false",
    `$deadline = $startedAt.AddMinutes(${SPLASH_TIMEOUT_MINUTES})`,
    "$seenAt = $null",
    "$tick = 0",
    "# 只轮询进程列表：应用已退出，任何安装目录内的读写都会干扰安装器。",
    "# 动画每 40ms 一帧，进程检测每 10 帧一次，够顺滑也不占 CPU。",
    "while ($form.Visible -and (Get-Date) -lt $deadline) {",
    "  [System.Windows.Forms.Application]::DoEvents()",
    `  $footText = ${waitedPrefix} + [int](((Get-Date) - $startedAt).TotalSeconds) + ${waitedSuffix}`,
    "  $form.Invalidate()",
    "  if ($tick % 10 -eq 0) {",
    `    $running = @(Get-Process -Name ${processName} -ErrorAction SilentlyContinue)`,
    "    $old = @($running | Where-Object { $known -contains $_.Id })",
    "    $fresh = @($running | Where-Object { $known -notcontains $_.Id })",
    "    if ($old.Count -eq 0 -and $fresh.Count -gt 0) {",
    "      if ($null -eq $seenAt) { $seenAt = Get-Date }",
    "      $visible = @($fresh | Where-Object { try { $_.MainWindowHandle.ToInt64() -gt 0 } catch { $false } })",
    "      if ($visible.Count -gt 0) { Start-Sleep -Milliseconds 400; break }",
    `      if (((Get-Date) - $seenAt).TotalSeconds -gt ${SPLASH_WINDOW_GRACE_SECONDS}) { break }`,
    "    }",
    "  }",
    "  $tick = $tick + 1",
    "  Start-Sleep -Milliseconds 40",
    "}",
    "if ($form.Visible -and ((Get-Date) -ge $deadline)) {",
    "  $failed = $true",
    `  $titleText = ${psQuote(text.failedTitle)}`,
    `  $subText = ${psQuote(text.failedHint)}`,
    `  $holdUntil = (Get-Date).AddMinutes(${SPLASH_FAILURE_HOLD_MINUTES})`,
    "  while ($form.Visible -and (Get-Date) -lt $holdUntil) {",
    "    [System.Windows.Forms.Application]::DoEvents()",
    "    $form.Invalidate()",
    "    Start-Sleep -Milliseconds 120",
    "  }",
    "}",
    "$form.Close()",
    "$form.Dispose()",
    "",
  ].join("\r\n");
}

/** PowerShell 单引号字符串只把成对的单引号当转义，其余字符按字面量处理。 */
function psQuote(value: string): string {
  return `'${value.replace(/\r?\n/g, " ").replace(/'/g, "''")}'`;
}
