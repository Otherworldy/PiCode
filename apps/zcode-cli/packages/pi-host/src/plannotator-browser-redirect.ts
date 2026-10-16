import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createHook, executionAsyncId, type AsyncHook } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

/**
 * 上游 0.28.22 起 `PLANNOTATOR_BROWSER` 的这些取值都是“什么都不开”（`off` / `no` 是这一版加的）；
 * 其余非空值才是显式浏览器，宿主放行插件自己的启动。
 */
const NOOP_BROWSER_VALUES = new Set(["none", "false", "0", "off", "no", "true", "1", ":"]);

/** 插件通知里带会话地址的三种文案（`sessionOpenedMessage` 与 `openBrowserForServer`）。 */
const NOTIFY_URL_PATTERNS: readonly RegExp[] = [
  /^Plannotator session ready: (https?:\/\/\S+)/,
  /^(?:Plannotator: plan review|Code review|Annotation|Last-message annotation) opened(?: at| — open) (https?:\/\/\S+)/,
  /^Could not open a browser automatically\. Open (https?:\/\/\S+) to review\./,
];

/** 地址后面的句号一类标点不属于 URL。 */
const TRAILING_URL_PUNCTUATION = /[.,;:!?)\]}>'"“”‘’]+$/;

const sessionByAsyncId = new Map<number, string>();
const openers = new Map<string, (url: string) => void>();
/** 每个会话已经交付过的审查页地址：spawn 拦截和插件通知都可能拿到同一个。 */
const deliveredUrls = new Map<string, Set<string>>();
const streamingSessions = new Set<string>();
let sessionHook: AsyncHook | undefined;
let installed = false;

/**
 * 插件的 openBrowser 和宿主在同一个进程里。拦住它的 spawn，才能不改插件源码
 * 就把审查页交给内置浏览器。显式 PLANNOTATOR_BROWSER 仍交给插件。
 */
export function installPlannotatorEmbeddedBrowserRedirect(): void {
  if (installed) return;
  installed = true;
  if (process.env.PLANNOTATOR_GLIMPSE === undefined) {
    process.env.PLANNOTATOR_GLIMPSE = "0";
  }
  if (!sessionHook) {
    sessionHook = createHook({
      init(asyncId, _type, triggerAsyncId) {
        const sessionId = sessionByAsyncId.get(triggerAsyncId);
        if (sessionId) sessionByAsyncId.set(asyncId, sessionId);
      },
      destroy(asyncId) {
        sessionByAsyncId.delete(asyncId);
      },
    });
    sessionHook.enable();
  }
  const childProcess = loadChildProcess();
  const original = childProcess.spawn;
  childProcess.spawn = function patchedSpawn(command: string, ...rest: unknown[]) {
    const args = rest[0];
    const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
    if (
      argv.length > 0 &&
      consumePlannotatorBrowserLaunch(String(command), argv, new Error().stack ?? "", process.env)
    ) {
      return fakeOpenedChild();
    }
    return original.apply(childProcess, [command, ...rest] as never);
  } as typeof original;
}

export function registerPlannotatorBrowserSession(
  sessionId: string,
  emit: (url: string) => void,
): () => void {
  openers.set(sessionId, emit);
  deliveredUrls.set(sessionId, new Set());
  return () => {
    if (openers.get(sessionId) !== emit) return;
    openers.delete(sessionId);
    deliveredUrls.delete(sessionId);
  };
}

/**
 * 同一个审查页在一个会话里只交付一次。插件先 spawn（宿主拦下），
 * 之后的通知还带同一个地址；两个入口都走这里。
 */
export function deliverPlannotatorSessionUrl(sessionId: string, url: string): boolean {
  const emit = openers.get(sessionId);
  if (!emit) return false;
  const delivered = deliveredUrls.get(sessionId);
  if (!delivered || delivered.has(url)) return false;
  delivered.add(url);
  emit(url);
  return true;
}

/** 插件回调和这次 spawn 要落在同一个会话上。 */
export function notePlannotatorBrowserSession(sessionId: string): void {
  sessionByAsyncId.set(executionAsyncId(), sessionId);
}

/** 审查页是在这一轮工具里打开的。异步上下文对不上时，用正在跑的那一个会话，不猜两个都在跑的。 */
export function setPlannotatorBrowserStreaming(sessionId: string, streaming: boolean): void {
  if (streaming) streamingSessions.add(sessionId);
  else streamingSessions.delete(sessionId);
}

export function plannotatorBrowserLaunchUrl(
  command: string,
  args: readonly string[] | undefined,
  stack: string,
  env: NodeJS.ProcessEnv,
): string | null {
  void command;
  if (!isPlannotatorNetworkStack(stack) || explicitPlannotatorBrowser(env)) return null;
  const url = (args ?? []).find((arg) => /^https?:\/\//i.test(arg));
  if (!url || !isHttpUrl(url)) return null;
  return url;
}

/**
 * 插件通知里的审查页地址。显式指定了浏览器时交给插件；其余情况（没设置或 none 值）
 * 从 `ctx.ui.notify` 里取，覆盖插件不 spawn 的路径：0.28.22 起 none 值一律不开浏览器，
 * 远程会话也不 spawn。同一地址的重复交付由 `deliverPlannotatorSessionUrl` 挡住。
 */
export function plannotatorSessionNotifyUrl(
  message: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (plannotatorBrowserChoice(env) === "explicit") return null;
  const text = message.trim();
  for (const pattern of NOTIFY_URL_PATTERNS) {
    const candidate = pattern.exec(text)?.[1]?.replace(TRAILING_URL_PUNCTUATION, "");
    if (candidate && isHttpUrl(candidate)) return candidate;
  }
  return null;
}

/**
 * 审查页关掉之后，同一个地址可以再打开一次：
 * 会话固定端口时，前后两轮审查会拿到同一个 URL。
 */
export function forgetPlannotatorSessionUrls(sessionId: string): void {
  deliveredUrls.get(sessionId)?.clear();
}

/** `PLANNOTATOR_BROWSER` 的取值归为三类：不开、显式浏览器、没设置。 */
export function plannotatorBrowserChoice(
  env: NodeJS.ProcessEnv,
): "none" | "explicit" | "unset" {
  const value = env.PLANNOTATOR_BROWSER?.trim().toLowerCase();
  if (!value) return "unset";
  return NOOP_BROWSER_VALUES.has(value) ? "none" : "explicit";
}

export function consumePlannotatorBrowserLaunch(
  command: string,
  args: readonly string[] | undefined,
  stack: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const url = plannotatorBrowserLaunchUrl(command, args, stack, env);
  if (!url) return null;
  const sessionId = resolveSessionId();
  if (!sessionId) return null;
  // 地址归这个会话：这次 spawn 一律吞掉，重复地址不再开第二个页。
  deliverPlannotatorSessionUrl(sessionId, url);
  return url;
}

function resolveSessionId(): string | undefined {
  const noted = sessionByAsyncId.get(executionAsyncId());
  if (noted && openers.has(noted)) return noted;
  const streaming = [...streamingSessions].filter((sessionId) => openers.has(sessionId));
  if (streaming.length === 1) return streaming[0];
  if (openers.size === 1) return openers.keys().next().value;
  return undefined;
}

function isPlannotatorNetworkStack(stack: string): boolean {
  return (
    stack.includes("plannotator") &&
    (stack.includes("network.ts") || stack.includes("network.js"))
  );
}

function explicitPlannotatorBrowser(env: NodeJS.ProcessEnv): boolean {
  return plannotatorBrowserChoice(env) === "explicit";
}

function isHttpUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * CJS 包里 import.meta.url 是空字符串。模块加载时 createRequire("") 会抛错，
 * --prepare-storage 进程直接退出，桌面只能看到 transport_closed。
 * 裸 node: 说明符不依赖脚本身份，用 execPath 即可。
 */
export function loadChildProcess(
  filename: string | undefined = import.meta.url,
): typeof import("node:child_process") {
  const base =
    typeof filename === "string" && filename.length > 0 ? filename : process.execPath;
  return createRequire(base)("node:child_process") as typeof import("node:child_process");
}

function fakeOpenedChild(): ChildProcess {
  const fake = new EventEmitter() as ChildProcess;
  fake.unref = () => fake;
  queueMicrotask(() => {
    fake.emit("spawn");
  });
  return fake;
}
