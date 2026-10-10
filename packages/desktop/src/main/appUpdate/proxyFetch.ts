import { readFileSync } from "node:fs";
import { ProxyAgent, fetch as undiciFetch } from "undici";

export interface UpdateNetworkSettings {
  httpProxy?: string;
  httpProxyNoProxy?: string;
  httpProxyCaCertPath?: string;
}

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
    return (await undiciFetch(url, {
      method: init?.method,
      headers: init?.headers,
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
