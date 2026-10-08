import type { ZCodePiPluginsResult } from "@zcode/shared";
import { create } from "zustand";
import {
  applyPiPluginUpdateSnapshot,
  type PiPluginUpdateSnapshot,
} from "@/lib/piPluginUpdateCheck.js";

export type PiPluginUpdate = NonNullable<ZCodePiPluginsResult["updates"]>[number];

type PiPluginUpdateState = PiPluginUpdateSnapshot & {
  updates: PiPluginUpdate[];
  apply: (workspaceKey: string, updates: PiPluginUpdate[], checkedAt?: number) => void;
};

export const usePiPluginUpdateStore = create<PiPluginUpdateState>((set) => ({
  workspaceKey: "",
  updates: [],
  apply(workspaceKey, updates, checkedAt) {
    set((current) => {
      const next = applyPiPluginUpdateSnapshot<PiPluginUpdate>(current, {
        workspaceKey,
        updates,
        ...(checkedAt !== undefined ? { checkedAt } : {}),
      });
      return {
        workspaceKey: next.workspaceKey,
        updates: [...next.updates],
        checkedAt: next.checkedAt,
      };
    });
  },
}));
