import { describe, expect, it, vi } from "vitest";
import { installDownloadedUpdate } from "./installDownloadedUpdate.js";

function installer() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const quit = vi.fn();
  const copyFileImpl = vi.fn(async () => undefined);
  const chmodImpl = vi.fn(async () => undefined);
  const spawnImpl = (command: string, args: string[]) => {
    calls.push({ command, args });
    return { unref: () => undefined };
  };
  return { calls, quit, copyFileImpl, chmodImpl, spawnImpl };
}

describe("install downloaded update", () => {
  it("opens a macOS disk image without quitting", async () => {
    const deps = installer();
    const kind = await installDownloadedUpdate({
      filePath: "/tmp/PiCode.dmg",
      platform: "darwin",
      quit: deps.quit,
      spawnImpl: deps.spawnImpl,
    });
    expect(kind).toBe("opened-installer");
    expect(deps.calls).toEqual([{ command: "open", args: ["/tmp/PiCode.dmg"] }]);
    expect(deps.quit).not.toHaveBeenCalled();
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
    });
    expect(kind).toBe("relaunch");
    expect(deps.copyFileImpl).toHaveBeenCalledWith("/tmp/PiCode.AppImage", "/opt/PiCode.AppImage");
    expect(deps.calls).toEqual([{ command: "/opt/PiCode.AppImage", args: [] }]);
    expect(deps.quit).toHaveBeenCalledOnce();
  });

  it("starts the Windows installer and quits", async () => {
    const deps = installer();
    const kind = await installDownloadedUpdate({
      filePath: "C:/tmp/PiCode.exe",
      platform: "win32",
      quit: deps.quit,
      spawnImpl: deps.spawnImpl,
    });
    expect(kind).toBe("quit-for-installer");
    expect(deps.calls).toEqual([{ command: "C:/tmp/PiCode.exe", args: [] }]);
    expect(deps.quit).toHaveBeenCalledOnce();
  });
});
