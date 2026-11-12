import type { Event } from "@picode/rpc";
import type {
  GenUiDocument,
  GenUiScope,
  GenUiStateChange,
  GenUiStateEntry,
  GenUiStateTarget,
  GenUiWidgetState,
} from "@picode/shared/gen-ui";
import type { PluginSandboxHandle } from "@picode/shared/mcp-apps";
import { createServiceDescriptor } from "../descriptors.js";

export interface GenUiPrepareParams extends GenUiStateTarget {
  html: string;
  ownerWebContentsId: number;
  instanceKey: string;
}
/** readDocument runs on the executor Host. State and sandbox methods run on desktop base services. */
export interface IGenUiService {
  readDocument(target: GenUiStateTarget): Promise<GenUiDocument>;
  prepareSandbox(input: GenUiPrepareParams): Promise<PluginSandboxHandle>;
  getState(target: GenUiStateTarget): Promise<GenUiWidgetState | null>;
  setState(input: { target: GenUiStateTarget; state: GenUiWidgetState }): Promise<void>;
  listState(scope: GenUiScope): Promise<GenUiStateEntry[]>;
  onStateChanged: Event<GenUiStateChange>;
}
export const IGenUiService = createServiceDescriptor<IGenUiService>("gen-ui");
