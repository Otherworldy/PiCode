import type { ControlledView } from "./browserCommandTypes.js";

const WORLD_NAME = "zcode-ref-batch";
const TABLE_GLOBAL = "__zcodeRefBatch";
const MAX_REFS = 200;
const MAX_ACTIONS = 8;
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

interface AxNode {
  backendDOMNodeId?: number;
  childIds?: string[];
  frameId?: string;
  ignored?: boolean;
  name?: unknown;
  nodeId?: string;
  role?: unknown;
}

interface CollectedRef {
  backendNodeId: number;
  frameId: string;
  frameLabel: string;
  name: string;
  role: string;
}

interface StoredRef {
  backendNodeId: number;
  name: string;
  role: string;
}

interface RefTable {
  lines: string[];
  next: number;
  refs: Record<string, StoredRef>;
  url: string;
}

export interface BrowserRefAction {
  op: "click" | "fill";
  ref: string;
  value?: string;
}

/**
 * 句柄表放在独立 isolated world。ControlledView 每次命令都是新对象，不能当所有者；
 * 页面主世界又能被站点清掉。backendDOMNodeId 跟文档走，DOM 重排不会让句柄指到别的元素。
 */
export async function captureBrowserRefSnapshot(view: ControlledView): Promise<string> {
  const url = view.webContents.getURL();
  const previous = await loadTable(view);
  const baseline = previous?.url === url ? previous : undefined;
  const table = assignRefs(baseline, await collectInteractive(view), url);
  await saveTable(view, table);
  return table.lines.join("\n");
}

export async function captureBrowserRefDiff(view: ControlledView): Promise<string> {
  const url = view.webContents.getURL();
  const previous = await loadTable(view);
  if (!previous || previous.url !== url) {
    throw new Error("browser ref snapshot is stale; call refSnapshot() again");
  }
  const table = assignRefs(previous, await collectInteractive(view), url);
  const diff = diffLines(previous.lines, table.lines);
  await saveTable(view, table);
  return diff;
}

export async function runBrowserRefBatch(
  view: ControlledView,
  actions: readonly BrowserRefAction[],
): Promise<{ applied: number }> {
  if (actions.length < 1 || actions.length > MAX_ACTIONS) {
    throw new Error(`refBatch accepts 1 to ${MAX_ACTIONS} actions`);
  }
  const url = view.webContents.getURL();
  const table = await loadTable(view);
  if (!table || table.url !== url) {
    throw new Error("browser ref snapshot is stale; call refSnapshot() again");
  }
  for (const action of actions) {
    const stored = table.refs[action.ref];
    if (!stored) throw new Error(`browser ref ${action.ref} is not in the latest refSnapshot()`);
    if (action.op === "fill") await fillNode(view, stored.backendNodeId, action.value ?? "");
    else await clickNode(view, stored.backendNodeId);
  }
  return { applied: actions.length };
}

async function collectInteractive(view: ControlledView): Promise<CollectedRef[]> {
  await view.cdp.send("Page.enable");
  await view.cdp.send("DOM.enable");
  await view.cdp.send("Runtime.enable");
  await view.cdp.send("Accessibility.enable");
  const tree = (await view.cdp.send("Page.getFrameTree")) as {
    frameTree?: {
      childFrames?: Array<{ frame?: { id?: string; name?: string; url?: string } }>;
      frame?: { id?: string };
    };
  };
  const mainFrameId = tree.frameTree?.frame?.id ?? "";
  const frames = new Map<string, string>([[mainFrameId, ""]]);
  for (const child of tree.frameTree?.childFrames ?? []) {
    const id = child.frame?.id;
    if (!id) continue;
    frames.set(id, child.frame?.name || child.frame?.url || "iframe");
  }
  const seen = new Set<number>();
  const collected: CollectedRef[] = [];
  for (const [frameId, frameLabel] of frames) {
    let nodes: AxNode[] = [];
    try {
      const response = (await view.cdp.send("Accessibility.getFullAXTree", {
        ...(frameId && frameId !== mainFrameId ? { frameId } : {}),
      })) as { nodes?: AxNode[] };
      nodes = response.nodes ?? [];
    } catch {
      // 跨域 iframe 读不到无障碍树时跳过，不让整页快照失败。
      continue;
    }
    for (const node of nodes) {
      if (node.ignored) continue;
      const backendNodeId = node.backendDOMNodeId;
      if (typeof backendNodeId !== "number" || seen.has(backendNodeId)) continue;
      const role = axValue(node.role).toLowerCase();
      if (!INTERACTIVE_ROLES.has(role)) continue;
      seen.add(backendNodeId);
      collected.push({
        backendNodeId,
        frameId,
        frameLabel,
        name: axValue(node.name).replaceAll("\n", " ").trim().slice(0, 80),
        role,
      });
      if (collected.length >= MAX_REFS) return collected;
    }
  }
  return collected;
}

function assignRefs(
  previous: RefTable | undefined,
  nodes: readonly CollectedRef[],
  url: string,
): RefTable {
  const byBackend = new Map<number, string>();
  for (const [ref, stored] of Object.entries(previous?.refs ?? {})) {
    byBackend.set(stored.backendNodeId, ref);
  }
  let next = previous?.next ?? 1;
  const refs: Record<string, StoredRef> = {};
  const grouped = new Map<string, string[]>();
  for (const node of nodes) {
    let ref = byBackend.get(node.backendNodeId);
    if (!ref) {
      ref = `e${next}`;
      next += 1;
    }
    refs[ref] = { backendNodeId: node.backendNodeId, name: node.name, role: node.role };
    const line = `${ref} [${node.role}]${node.name ? ` "${node.name}"` : ""}`;
    const bucket = grouped.get(node.frameId) ?? [];
    bucket.push(node.frameLabel ? `  ${line}` : line);
    grouped.set(node.frameId, bucket);
  }
  const lines: string[] = [];
  for (const [frameId, bucket] of grouped) {
    const label = nodes.find((node) => node.frameId === frameId)?.frameLabel;
    if (label) lines.push(`[Iframe] "${label}"`);
    lines.push(...bucket);
  }
  return { lines, next, refs, url };
}

function diffLines(previous: readonly string[], next: readonly string[]): string {
  const previousKeys = new Set(previous.map(lineKey));
  const nextKeys = new Set(next.map(lineKey));
  const removed = previous
    .filter((line) => !nextKeys.has(lineKey(line)))
    .map((line) => `- ${lineKey(line)}`);
  const added = next.filter((line) => !previousKeys.has(lineKey(line))).map((line) => `+ ${line}`);
  if (removed.length === 0 && added.length === 0) return "(no changes)";
  return [...removed, ...added].join("\n");
}

function lineKey(line: string): string {
  return line.trim().replace(/^e\d+\s+/u, "");
}

async function fillNode(view: ControlledView, backendNodeId: number, value: string): Promise<void> {
  await withNode(view, backendNodeId, FILL_NODE, value);
}

async function clickNode(view: ControlledView, backendNodeId: number): Promise<void> {
  const point = (await withNode(view, backendNodeId, CLICK_POINT, undefined)) as {
    x?: number;
    y?: number;
  };
  if (typeof point?.x !== "number" || typeof point.y !== "number") {
    throw new Error("browser ref did not resolve to a clickable box");
  }
  await view.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
  await view.cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
  });
}

async function withNode(
  view: ControlledView,
  backendNodeId: number,
  source: string,
  arg: string | undefined,
): Promise<unknown> {
  const resolved = (await view.cdp.send("DOM.resolveNode", { backendNodeId })) as {
    object?: { objectId?: string };
  };
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("browser ref node is gone; call refSnapshot() again");
  try {
    const response = (await view.cdp.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: source,
      arguments: arg === undefined ? [] : [{ value: arg }],
      awaitPromise: true,
      returnByValue: true,
    })) as {
      exceptionDetails?: { text?: string; exception?: { description?: string } };
      result?: { value?: unknown };
    };
    if (response.exceptionDetails) {
      throw new Error(
        response.exceptionDetails.exception?.description ??
          response.exceptionDetails.text ??
          "browser ref action failed",
      );
    }
    return response.result?.value;
  } finally {
    await view.cdp.send("Runtime.releaseObject", { objectId }).catch(() => undefined);
  }
}

async function ensureWorld(view: ControlledView): Promise<number> {
  const tree = (await view.cdp.send("Page.getFrameTree")) as {
    frameTree?: { frame?: { id?: string } };
  };
  const frameId = tree.frameTree?.frame?.id;
  if (!frameId) throw new Error("Page.getFrameTree returned no main frame");
  const world = (await view.cdp.send("Page.createIsolatedWorld", {
    frameId,
    grantUniveralAccess: false,
    worldName: WORLD_NAME,
  })) as { executionContextId?: number };
  if (!world.executionContextId) throw new Error("Unable to create ref snapshot world");
  return world.executionContextId;
}

async function loadTable(view: ControlledView): Promise<RefTable | undefined> {
  const contextId = await ensureWorld(view);
  const value = await evaluate(view, contextId, `globalThis.${TABLE_GLOBAL} ?? null`);
  if (!value || typeof value !== "object") return undefined;
  return value as RefTable;
}

async function saveTable(view: ControlledView, table: RefTable): Promise<void> {
  const contextId = await ensureWorld(view);
  await evaluate(
    view,
    contextId,
    `globalThis.${TABLE_GLOBAL} = ${JSON.stringify(table)}; true`,
  );
}

async function evaluate(
  view: ControlledView,
  contextId: number,
  expression: string,
): Promise<unknown> {
  const response = (await view.cdp.send("Runtime.evaluate", {
    contextId,
    expression,
    returnByValue: true,
  })) as {
    exceptionDetails?: { text?: string; exception?: { description?: string } };
    result?: { value?: unknown };
  };
  if (response.exceptionDetails) {
    throw new Error(
      response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text ??
        "ref table evaluation failed",
    );
  }
  return response.result?.value;
}

function axValue(field: unknown): string {
  if (typeof field === "string") return field;
  if (field && typeof field === "object" && "value" in field) {
    const value = (field as { value?: unknown }).value;
    return value == null ? "" : String(value);
  }
  return "";
}

const FILL_NODE = `function(value) {
  this.focus();
  var proto = Object.getPrototypeOf(this);
  var desc = proto && Object.getOwnPropertyDescriptor(proto, "value");
  if (desc && desc.set) desc.set.call(this, value);
  else this.value = value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}`;

const CLICK_POINT = `function() {
  this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  var rect = this.getBoundingClientRect();
  var x = rect.x + rect.width / 2;
  var y = rect.y + rect.height / 2;
  var win = this.ownerDocument.defaultView;
  var top = win && win.top;
  while (win && win !== top) {
    var frameEl = null;
    try { frameEl = win.frameElement; } catch (error) { frameEl = null; }
    if (!frameEl) break;
    var frameRect = frameEl.getBoundingClientRect();
    x += frameRect.x;
    y += frameRect.y;
    win = win.parent;
  }
  return { x: x, y: y };
}`;
