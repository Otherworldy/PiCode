export interface PluginViewRequest {
  pluginId?: string;
  view?: string;
  state?: unknown;
}

export interface PluginViewAdapter {
  renderText(request: PluginViewRequest): string[] | undefined;
}

/** 空表。未命中则 custom() 降级为 widget 文本。名单后补。 */
export class PluginViewRegistry {
  constructor(private readonly adapters: ReadonlyMap<string, PluginViewAdapter> = new Map()) {}

  lookup(pluginId: string | undefined): PluginViewAdapter | undefined {
    if (!pluginId) return undefined;
    return this.adapters.get(pluginId);
  }

  resolveCustom(request: PluginViewRequest): string[] {
    const lines = this.lookup(request.pluginId)?.renderText(request);
    if (lines && lines.length > 0) return lines;
    if (typeof request.state === "string" && request.state.trim()) return [request.state];
    return ["(unsupported plugin view)"];
  }
}

export const EMPTY_PLUGIN_VIEW_REGISTRY = new PluginViewRegistry();
