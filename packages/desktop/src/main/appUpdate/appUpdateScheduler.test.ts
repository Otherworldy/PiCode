import { describe, expect, it, vi } from "vitest";
import type { AppUpdateSnapshot } from "@zcode/shared";
import { pollAppUpdate } from "./appUpdateScheduler.js";

function snapshot(phase: AppUpdateSnapshot["phase"]): AppUpdateSnapshot {
  return { phase, currentVersion: "3.14.6" };
}

describe("app update scheduler", () => {
  it("downloads an available update without installing", async () => {
    const check = vi.fn(async () => snapshot("available"));
    const download = vi.fn(async () => snapshot("downloaded"));
    await pollAppUpdate({ snapshot: () => snapshot("idle"), check, download });
    expect(check).toHaveBeenCalledOnce();
    expect(download).toHaveBeenCalledOnce();
  });

  it("checks again after a download but does not interrupt one that is running", async () => {
    const check = vi.fn(async () => snapshot("downloaded"));
    const download = vi.fn(async () => snapshot("downloaded"));
    await pollAppUpdate({ snapshot: () => snapshot("downloaded"), check, download });
    await pollAppUpdate({ snapshot: () => snapshot("downloading"), check, download });
    expect(check).toHaveBeenCalledOnce();
    expect(download).not.toHaveBeenCalled();
  });
});
