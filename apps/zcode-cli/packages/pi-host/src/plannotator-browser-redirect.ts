import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { createHook, executionAsyncId, type AsyncHook } from "node:async_hooks";
import type { ChildProcess } from "node:child_process";

const NOOP_BROWSER_VALUES = new Set(["true", "false", "none", ":", "0", "1"]);

const sessionByAsyncId = new Map<number, string>();
const openers = new Map<string, (url: string) => void>();
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
  return () => {
    if (openers.get(sessionId) === emit) openers.delete(sessionId);
  };
}

/** 插件回调和这次 spawn 要落在同一个会话上。 */
export function notePlannotatorBrowserSession(sessionId: string): void {
  sessionByAsyncId.set(executionAsyncId(), sessionId);
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

export function consumePlannotatorBrowserLaunch(
  command: string,
  args: readonly string[] | undefined,
  stack: string,
  env: NodeJS.ProcessEnv,
): string | null {
  const url = plannotatorBrowserLaunchUrl(command, args, stack, env);
  if (!url) return null;
  const sessionId = resolveSessionId();
  const emit = sessionId ? openers.get(sessionId) : undefined;
  if (!emit) return null;
  emit(url);
  return url;
}

function resolveSessionId(): string | undefined {
  const noted = sessionByAsyncId.get(executionAsyncId());
  if (noted && openers.has(noted)) return noted;
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
  const value = env.PLANNOTATOR_BROWSER?.trim();
  if (!value) return false;
  return !NOOP_BROWSER_VALUES.has(value.toLowerCase());
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
