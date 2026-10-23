import { readFileSync } from "node:fs";
import { ProxyAgent, fetch as undiciFetch } from "undici";

export interface UpdateNetworkSettings {
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
}

/**
 * 按 (proxy, ca) 缓存的 undici agent。key 由用户设置决定，domain 很小 —— 但每个旧 agent
 * 持有连接池与 socket，用户改几次代理就会留下一串不释放的池。
 */
const MAX_PROXY_AGENTS = 4;
const proxyAgents = new Map<string, ProxyAgent>();

export function normalizeUpdateProxy(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (!url.host) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function shouldBypassUpdateProxy(targetUrl: string, noProxy: string | undefined): boolean {
  const tokens =
    noProxy
      ?.split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return false;
  let host = "";
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return tokens.some((token) => token === "*" || host === token || host.endsWith(`.${token}`));
}

export function createUpdateFetch(settings: UpdateNetworkSettings): typeof fetch {
  const proxy = normalizeUpdateProxy(settings.httpProxy);
  return (async (input, init) => {
    const url = resolveRequestUrl(input);
    if (!proxy || shouldBypassUpdateProxy(url, settings.httpProxyNoProxy)) {
      return fetch(input, init);
    }
    // Node 自带的 fetch 不走 Electron session，设置页代理只配在 Chromium 上。
    // 更新检查和安装包下载必须显式走这份代理，否则国内直连 GitHub 会很慢。
    const dispatcher = proxyAgent(proxy, settings.httpProxyCaCertPath);
    // init.headers 来自 Node 全局 fetch（undici-types 声明），与 undici 包的 HeadersInit 不是同一套
    // 类型（两个 Headers 类互不兼容）；用 Headers 归一成普通记录再交给 undici。
    const headers = init?.headers ? Object.fromEntries(new Headers(init.headers)) : undefined;
    return (await undiciFetch(url, {
      method: init?.method,
      headers,
      body: init?.body as never,
      signal: init?.signal ?? undefined,
      redirect: init?.redirect,
      dispatcher,
    })) as unknown as Response;
  }) as typeof fetch;
}

function proxyAgent(proxy: string, caCertPath: string | undefined): ProxyAgent {
  const ca = readCa(caCertPath);
  const key = `${proxy}\n${ca ?? ""}`;
  const existing = proxyAgents.get(key);
  if (existing) return existing;
  const agent = new ProxyAgent({
    uri: proxy,
    ...(ca ? { requestTls: { ca } } : {}),
  });
  proxyAgents.set(key, agent);
  // 超额时关掉最旧的 agent：只从表里删掉而不 close，它的连接池会一直占着 socket。
  while (proxyAgents.size > MAX_PROXY_AGENTS) {
    const oldestKey = proxyAgents.keys().next().value;
    if (oldestKey === undefined) break;
    const stale = proxyAgents.get(oldestKey);
    proxyAgents.delete(oldestKey);
    void stale?.close().catch(() => undefined);
  }
  return agent;
}

function readCa(caCertPath: string | undefined): string | undefined {
  const trimmed = caCertPath?.trim();
  if (!trimmed) return undefined;
  try {
    const pem = readFileSync(trimmed, "utf8");
    return pem.includes("BEGIN CERTIFICATE") ? pem : undefined;
  } catch {
    return undefined;
  }
}

function resolveRequestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
