import http from "node:http";
import https from "node:https";
import { ProxyAgent } from "proxy-agent";
import { ZCODE_HTTP_PROXY_ENV_KEY, ZCODE_NO_PROXY_ENV_KEY } from "@zcode/shared";
import {
  loadTlsCaCertificates,
  resolveProxyUrlForRequest,
  resolveTlsCaCertFile,
} from "./http-config.js";
import { responseFromNodeMessage } from "./incoming-message-response.js";
import { publishConfiguredProxyEnv } from "./subprocess-env.js";

type NetworkFetch = typeof globalThis.fetch;

interface NetworkProxyFetchOptions {
  caCertFile?: string;
  env?: Record<string, string | undefined>;
  fetch?: NetworkFetch;
  httpProxy?: string;
  noProxy?: string;
}

interface NormalizedFetchRequest {
  body?: Buffer;
  headers: Headers;
  method: string;
  signal?: AbortSignal | null;
  url: URL;
}

const PROCESS_PROXY_FETCH = Symbol.for("zcode.processProxyFetch");
const inflightNetworkFetches = new Set<() => void>();

/**
 * Stop 时 Pi 的 abort 信号可能到不了这条 socket（代理 CONNECT 挂起、重试中的下一次请求）。
 * 直接拆掉还没结束的代理请求。MCP 的长连接也会被拆，客户端会重连。
 */
export function abortInflightNetworkFetches(): void {
  while (inflightNetworkFetches.size > 0) {
    const abort = inflightNetworkFetches.values().next().value;
    if (!abort) break;
    inflightNetworkFetches.delete(abort);
    try {
      abort();
    } catch {
      // ClientRequest.destroy 有时会把 AbortError 同步抛出。调用方是 Stop，不能再往外抛。
    }
  }
}

/** Pi 的模型请求用 global fetch，bash 继承 process.env。两者都要看到设置页代理。 */
export function installProcessProxyFetch(
  env: Record<string, string | undefined> = process.env,
): void {
  publishConfiguredProxyEnv(env);
  const httpProxy = env[ZCODE_HTTP_PROXY_ENV_KEY]?.trim();
  if (!httpProxy || env !== process.env) return;
  const current = globalThis.fetch as NetworkFetch & { [PROCESS_PROXY_FETCH]?: true };
  if (current[PROCESS_PROXY_FETCH]) return;
  const proxied = createNetworkProxyFetch({
    env,
    httpProxy,
    noProxy: env[ZCODE_NO_PROXY_ENV_KEY],
  }) as NetworkFetch & { [PROCESS_PROXY_FETCH]?: true };
  proxied[PROCESS_PROXY_FETCH] = true;
  globalThis.fetch = proxied;
}

export function createNetworkProxyFetch(options: NetworkProxyFetchOptions): NetworkFetch {
  const directFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  if (!hasNetworkFetchPolicy(options)) {
    return directFetch;
  }

  let tlsCaCertificates: Buffer | undefined;
  let tlsCaCertificatesLoaded = false;

  const getTlsCaCertificates = (): Buffer | undefined => {
    if (!tlsCaCertificatesLoaded) {
      tlsCaCertificates = loadTlsCaCertificates(options);
      tlsCaCertificatesLoaded = true;
    }
    return tlsCaCertificates;
  };

  return async (input, init) => {
    const requestUrl = readFetchInputUrl(input);
    if (!requestUrl || (requestUrl.protocol !== "http:" && requestUrl.protocol !== "https:")) {
      return directFetch(input, init);
    }

    const proxyUrl = resolveProxyUrlForRequest(requestUrl, options);
    const caCertFile = resolveTlsCaCertFile(options);
    if (!proxyUrl && !caCertFile) {
      return directFetch(input, init);
    }

    const request = await normalizeFetchRequest(input, init);
    return fetchWithAgent(request, {
      ca: caCertFile ? getTlsCaCertificates() : undefined,
      proxyUrl,
    });
  };
}

function hasNetworkFetchPolicy(options: NetworkProxyFetchOptions): boolean {
  return Boolean(options.caCertFile || options.env || options.httpProxy || options.noProxy);
}

function readFetchInputUrl(input: Parameters<NetworkFetch>[0]): URL | undefined {
  try {
    if (input instanceof URL) {
      return input;
    }
    if (input instanceof Request) {
      return new URL(input.url);
    }
    return new URL(String(input));
  } catch {
    return undefined;
  }
}

async function normalizeFetchRequest(
  input: Parameters<NetworkFetch>[0],
  init: Parameters<NetworkFetch>[1],
): Promise<NormalizedFetchRequest> {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  const arrayBuffer =
    method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
  const body = arrayBuffer && arrayBuffer.byteLength > 0 ? Buffer.from(arrayBuffer) : undefined;

  return {
    body,
    headers: request.headers,
    method,
    signal: request.signal,
    url: new URL(request.url),
  };
}

function fetchWithAgent(
  request: NormalizedFetchRequest,
  options: { ca?: Buffer; proxyUrl?: string },
): Promise<Response> {
  const transport = request.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const signal = request.signal ?? undefined;
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    let settled = false;
    let responseMessage: http.IncomingMessage | undefined;
    let clientRequest: http.ClientRequest | undefined;

    const cleanupAll = (): void => {
      inflightNetworkFetches.delete(onAbort);
      signal?.removeEventListener("abort", onAbort);
      clientRequest?.off("error", onRequestError);
      clientRequest?.off("close", onRequestClose);
      responseMessage?.off("close", cleanupAll);
      responseMessage?.off("error", onResponseError);
    };
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanupAll();
      reject(error);
    };
    const onRequestError = (error: Error): void => {
      rejectOnce(error);
    };
    const onRequestClose = (): void => {
      if (!responseMessage && settled) cleanupAll();
    };
    const onResponseError = (): void => {
      // The web Response body receives the stream error through Readable.toWeb;
      // this listener only prevents Node from treating abort destroy as unhandled.
    };
    const onAbort = (): void => {
      const error = abortReason(signal);
      try {
        clientRequest?.socket?.on("error", () => undefined);
        responseMessage?.on("error", () => undefined);
        responseMessage?.destroy(error);
        clientRequest?.destroy(error);
      } catch {
        // 隧道已经建好时 destroy 会把 AbortError 同步抛出来。请求本身仍要拒绝。
      } finally {
        rejectOnce(error);
      }
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    inflightNetworkFetches.add(onAbort);
    const agent = createRequestAgent(request.url, options);
    // 拆掉 CONNECT 时 https-proxy-agent 的 promise 会在请求销毁后拒绝。不接住，Stop 会打崩进程。
    watchProxyConnect(agent);
    agent.on("error", () => undefined);

    clientRequest = transport.request(
      {
        agent,
        headers: headersToOutgoing(request.headers),
        hostname: request.url.hostname,
        method: request.method,
        path: `${request.url.pathname}${request.url.search}`,
        port: request.url.port || undefined,
        protocol: request.url.protocol,
      },
      (message) => {
        responseMessage = message;
        responseMessage.once("close", cleanupAll);
        responseMessage.once("error", onResponseError);
        // 构造失败必须拒绝这次请求。回调里的同步抛出会变成 uncaughtException，打崩 Agent。
        try {
          const response = responseFromNodeMessage(message);
          settled = true;
          resolve(response);
        } catch (error) {
          rejectOnce(error);
        }
      },
    );

    clientRequest.once("error", onRequestError);
    clientRequest.on("error", () => undefined);
    const ignoreSocketError = (socket: NodeJS.EventEmitter): void => {
      socket.on("error", () => undefined);
    };
    clientRequest.on("socket", ignoreSocketError);
    if (clientRequest.socket) ignoreSocketError(clientRequest.socket);
    clientRequest.once("close", onRequestClose);
    clientRequest.end(request.body);
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }

  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

const PROXY_CONNECT_WATCHED = Symbol.for("zcode.proxyConnectWatched");

function watchProxyConnect(agent: http.Agent): void {
  const record = agent as http.Agent & {
    [PROXY_CONNECT_WATCHED]?: true;
    connect?: (this: unknown, ...args: never[]) => unknown;
  };
  if (record[PROXY_CONNECT_WATCHED] || !record.connect) return;
  record[PROXY_CONNECT_WATCHED] = true;
  const connect = record.connect;
  record.connect = function (this: unknown, ...args: never[]) {
    const result = connect.apply(this, args);
    if (result && typeof (result as Promise<unknown>).then === "function") {
      // 接住拒绝，避免 Stop 拆 socket 后变成 unhandledRejection。Node 自己的 await 仍能看到失败。
      void (result as Promise<unknown>).then(
        (inner) => {
          if (inner && typeof inner === "object" && "connect" in inner) {
            watchProxyConnect(inner as unknown as http.Agent);
          }
        },
        () => undefined,
      );
    }
    return result;
  };
}

function createRequestAgent(
  url: URL,
  options: { ca?: Buffer; proxyUrl?: string },
): http.Agent | https.Agent | ProxyAgent {
  if (options.proxyUrl) {
    return new ProxyAgent({
      ca: options.ca,
      getProxyForUrl: () => options.proxyUrl ?? "",
      httpsAgent: options.ca ? new https.Agent({ ca: options.ca }) : undefined,
    }) as unknown as http.Agent;
  }

  if (url.protocol === "https:") {
    return new https.Agent({ ca: options.ca });
  }
  return new http.Agent();
}

function headersToOutgoing(headers: Headers): http.OutgoingHttpHeaders {
  const outgoing: http.OutgoingHttpHeaders = {};
  headers.forEach((value, key) => {
    outgoing[key] = value;
  });
  return outgoing;
}
