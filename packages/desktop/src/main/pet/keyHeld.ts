import { spawn, type ChildProcess } from "node:child_process";

const HOLD_RELEASE_GRACE_MS = 250;

export interface HoldLatch {
  latched: boolean;
  seenDown: boolean;
  since: number;
}

export interface KeyHeldProbe {
  down(): boolean;
  alive(): boolean;
  stop(): void;
}

/** 按下后开始计时。全局热键没有松开事件，要等采样看到按下，再看到松开。 */
export function noteHoldPress(now: number): HoldLatch {
  return { latched: true, seenDown: false, since: now };
}

export function pollHoldLatch(
  state: HoldLatch,
  keyDown: boolean,
  probeAlive: boolean,
  now: number,
): { state: HoldLatch; release: boolean } {
  if (!state.latched) return { state, release: false };
  if (!probeAlive) return { state: { ...state, latched: false }, release: true };
  if (keyDown) return { state: { ...state, seenDown: true }, release: false };
  if (!state.seenDown && now - state.since < HOLD_RELEASE_GRACE_MS)
    return { state, release: false };
  return { state: { ...state, latched: false }, release: true };
}

/** 把快捷键编成按键组。组内任一按下即可，组之间都要按下。读不到的平台返回 null。 */
export function readerHoldChord(accelerator: string, platform: NodeJS.Platform): string | null {
  if (platform !== "win32" && platform !== "darwin") return null;
  const parts = accelerator.split("+").filter(Boolean);
  const key = parts.pop();
  if (!key) return null;
  const groups: number[][] = [];
  for (const mod of parts) {
    const codes = modifierCodes(mod, platform);
    if (!codes) return null;
    groups.push(codes);
  }
  const main = keyCodes(key, platform);
  if (!main) return null;
  groups.push(main);
  const chord = groups.map((group) => group.join(",")).join(";");
  return /^[0-9,;]+$/.test(chord) ? chord : null;
}

export function startReaderHoldProbe(
  accelerator: string,
  platform: NodeJS.Platform = process.platform,
): KeyHeldProbe | null {
  const chord = readerHoldChord(accelerator, platform);
  if (!chord) return null;
  if (platform === "win32") {
    return spawnProbe(
      windowsPowerShell(),
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROBE],
      chord,
    );
  }
  if (platform === "darwin") {
    return spawnProbe("/usr/bin/osascript", ["-l", "JavaScript", "-e", DARWIN_PROBE], chord);
  }
  return null;
}

function spawnProbe(command: string, args: string[], chord: string): KeyHeldProbe | null {
  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, PET_CHORD: chord },
    });
  } catch {
    return null;
  }
  const output = child.stdout;
  if (!output) {
    child.kill();
    return null;
  }
  let buffer = "";
  let held = false;
  let alive = true;
  const stop = () => {
    if (!alive) return;
    alive = false;
    child.kill();
  };
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === "1" || line === "0") {
        held = line === "1";
        break;
      }
    }
  });
  child.on("error", stop);
  child.on("exit", () => {
    alive = false;
  });
  return {
    down: () => held,
    alive: () => alive,
    stop,
  };
}

function windowsPowerShell(): string {
  const root = process.env.SystemRoot;
  return root ? `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe` : "powershell.exe";
}

function modifierCodes(mod: string, platform: NodeJS.Platform): number[] | null {
  if (platform === "win32") {
    if (mod === "Shift") return [0x10];
    if (mod === "CommandOrControl") return [0x11];
    if (mod === "Alt") return [0x12];
    if (mod === "Super") return [0x5b, 0x5c];
    return null;
  }
  if (mod === "Shift") return [56, 60];
  if (mod === "CommandOrControl" || mod === "Super") return [55, 54];
  if (mod === "Alt") return [58, 61];
  return null;
}

function keyCodes(key: string, platform: NodeJS.Platform): number[] | null {
  const fn = /^F(\d+)$/.exec(key);
  if (fn) {
    const index = Number(fn[1]);
    if (platform === "win32" && index >= 1 && index <= 24) return [0x6f + index];
    return platform === "darwin" ? macFunctionKey(index) : null;
  }
  if (!/^[A-Z]$/.test(key)) return null;
  if (platform === "win32") return [key.charCodeAt(0)];
  const mac = MAC_LETTERS[key];
  return mac === undefined ? null : [mac];
}

function macFunctionKey(index: number): number[] | null {
  const code = MAC_FUNCTION_KEYS[index];
  return code === undefined ? null : [code];
}

const MAC_FUNCTION_KEYS: Record<number, number> = {
  1: 122,
  2: 120,
  3: 99,
  4: 118,
  5: 96,
  6: 97,
  7: 98,
  8: 100,
  9: 101,
  10: 109,
  11: 103,
  12: 111,
  13: 105,
  14: 107,
  15: 113,
  16: 106,
  17: 64,
  18: 79,
  19: 80,
  20: 90,
};

const MAC_LETTERS: Record<string, number> = {
  A: 0,
  B: 11,
  C: 8,
  D: 2,
  E: 14,
  F: 3,
  G: 5,
  H: 4,
  I: 34,
  J: 38,
  K: 40,
  L: 37,
  M: 46,
  N: 45,
  O: 31,
  P: 35,
  Q: 12,
  R: 15,
  S: 1,
  T: 17,
  U: 32,
  V: 9,
  W: 13,
  X: 7,
  Y: 16,
  Z: 6,
};

const WINDOWS_PROBE = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PetKeyState {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
}
'@
$stdout = [Console]::OpenStandardOutput()
$spec = $env:PET_CHORD
while ($true) {
  $ok = $true
  foreach ($group in $spec.Split(';')) {
    $any = $false
    foreach ($part in $group.Split(',')) {
      $code = 0
      if ([int]::TryParse($part, [ref]$code) -and ([PetKeyState]::GetAsyncKeyState($code) -band 0x8000) -ne 0) { $any = $true }
    }
    if (-not $any) { $ok = $false }
  }
  $bytes = $(if ($ok) { [byte[]](49,10) } else { [byte[]](48,10) })
  $stdout.Write($bytes, 0, 2)
  $stdout.Flush()
  Start-Sleep -Milliseconds 30
}
`;

const DARWIN_PROBE = `
ObjC.import("CoreGraphics");
var spec = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("PET_CHORD"));
var out = $.NSFileHandle.fileHandleWithStandardOutput;
function emit(down) {
  var text = $.NSString.alloc.initWithUTF8String(down ? "1\\n" : "0\\n");
  out.writeData(text.dataUsingEncoding(4));
}
while (true) {
  var ok = true;
  var groups = String(spec).split(";");
  for (var i = 0; i < groups.length; i++) {
    var any = false;
    var parts = groups[i].split(",");
    for (var j = 0; j < parts.length; j++) {
      if ($.CGEventSourceKeyState(1, parseInt(parts[j], 10))) any = true;
    }
    if (!any) ok = false;
  }
  emit(ok);
  delay(0.03);
}
`;
