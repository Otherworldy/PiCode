import { describe, expect, it, vi } from "vitest";
import { installDownloadedUpdate } from "./installDownloadedUpdate.js";

function installer() {
  // quit 与 sleep 也进 calls：只钉住 spawn 顺序会漏掉「先停留、再退出」这类回归。
  const calls: Array<{ command: string; args: string[] }> = [];
  const quit = vi.fn(() => {
    calls.push({ command: "quit", args: [] });
  });
  const copyFileImpl = vi.fn(async () => undefined);
  const chmodImpl = vi.fn(async () => undefined);
  const sleepImpl = vi.fn(async (ms: number) => {
    calls.push({ command: "sleep", args: [String(ms)] });
  });
  const splash = vi.fn(async () => {
    calls.push({ command: "splash", args: [] });
  });
  const spawnImpl = (command: string, args: string[]) => {
    calls.push({ command, args });
    return { unref: () => undefined };
  };
  return { calls, quit, copyFileImpl, chmodImpl, sleepImpl, splash, spawnImpl };
}

describe("install downloaded update", () => {
  it("opens a macOS disk image without quitting or showing progress", async () => {
    const deps = installer();
    const kind = await installDownloadedUpdate({
      filePath: "/tmp/PiCode.dmg",
      platform: "darwin",
      quit: deps.quit,
      spawnImpl: deps.spawnImpl,
      sleepImpl: deps.sleepImpl,
      splash: deps.splash,
    });
    expect(kind).toBe("opened-installer");
    expect(deps.calls).toEqual([{ command: "open", args: ["/tmp/PiCode.dmg"] }]);
    expect(deps.sleepImpl).not.toHaveBeenCalled();
    expect(deps.splash).not.toHaveBeenCalled();
  });

  it("replaces the running AppImage and quits", async () => {
    const deps = installer();
    const kind = await installDownloadedUpdate({
      filePath: "/tmp/PiCode.AppImage",
      platform: "linux",
      appImagePath: "/opt/PiCode.AppImage",
      quit: deps.quit,
      spawnImpl: deps.spawnImpl,
      copyFileImpl: deps.copyFileImpl,
      chmodImpl: deps.chmodImpl,
      sleepImpl: deps.sleepImpl,
      splash: deps.splash,
    });
    expect(kind).toBe("relaunch");
    expect(deps.copyFileImpl).toHaveBeenCalledWith("/tmp/PiCode.AppImage", "/opt/PiCode.AppImage");
    expect(deps.calls).toEqual([
      { command: "/opt/PiCode.AppImage", args: [] },
      { command: "quit", args: [] },
    ]);
    expect(deps.splash).not.toHaveBeenCalled();
  });

  it("waits for the notice, then hands over to the splash before the Windows installer", async () => {
    const deps = installer();
    const kind = await installDownloadedUpdate({
      filePath: "C:/tmp/PiCode.exe",
      platform: "win32",
      quit: deps.quit,
      spawnImpl: deps.spawnImpl,
      sleepImpl: deps.sleepImpl,
      splash: deps.splash,
    });
    expect(kind).toBe("quit-for-installer");
    // 顺序即体验：等待态先可读，小窗随后接手，安装器最后才接管文件。
    expect(deps.calls).toEqual([
      { command: "sleep", args: ["2500"] },
      { command: "splash", args: [] },
      { command: "C:/tmp/PiCode.exe", args: ["/S", "--updated", "--force-run"] },
      { command: "quit", args: [] },
    ]);
  });

  it("still starts the installer when the progress splash fails", async () => {
    const deps = installer();
    const kind = await installDownloadedUpdate({
      filePath: "C:/tmp/PiCode.exe",
      platform: "win32",
      quit: deps.quit,
      spawnImpl: deps.spawnImpl,
      sleepImpl: deps.sleepImpl,
      splash: async () => {
        throw new Error("powershell blocked");
      },
    });
    expect(kind).toBe("quit-for-installer");
    expect(deps.calls).toEqual([
      { command: "sleep", args: ["2500"] },
      { command: "C:/tmp/PiCode.exe", args: ["/S", "--updated", "--force-run"] },
      { command: "quit", args: [] },
    ]);
  });
});
