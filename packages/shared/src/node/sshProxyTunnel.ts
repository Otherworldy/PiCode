import { connect as connectSocket, createServer, type Server, type Socket } from "node:net";
import type { SshProxyEndpoint } from "../remoteTarget.js";

/**
 * 远程连接走的代理：SOCKS5（RFC 1928 + 1929）与 HTTP CONNECT。
 *
 * 采用本地转发器而不是 `ssh -o ProxyCommand`：ProxyCommand 需要外部 helper
 * （`nc -X 5` / `connect`）或一个能被 ssh 直接执行的可执行文件，Windows 上
 * 前者不保证存在，后者要处理 `C:\Program Files\...` 的空格与引号。本地转发器
 * 全在 Node 里完成，ssh 只连 127.0.0.1，跟平台无关。
 */

/** ssh/scp 实际连接的本机端点。 */
export interface SshTunnelEndpoint {
  host: string;
  port: number;
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
/** 没有任何活跃连接时的空闲回收时间；有连接在用就不回收。 */
const FORWARDER_IDLE_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

interface Forwarder {
  endpoint: SshTunnelEndpoint;
  server: Server;
  lastUsed: number;
  active: number;
}

const forwarders = new Map<string, Promise<Forwarder>>();
let sweepTimer: NodeJS.Timeout | undefined;
let lastTunnelError: string | undefined;

/** 最近一次隧道握手失败原因：ssh 只会报「连接被关闭」，真实原因需要这里补上。 */
export function lastSshProxyTunnelError(): string | undefined {
  return lastTunnelError;
}

interface Reader {
  read(size: number): Promise<Buffer>;
  /** 停止接管 socket 数据，返回尚未消费的字节供 unshift 回 socket。 */
  detach(): Buffer;
}

function createReader(socket: Socket): Reader {
  let buffer = Buffer.alloc(0);
  let failure: Error | undefined;
  let waiter:
    | { size: number; resolve: (chunk: Buffer) => void; reject: (error: Error) => void }
    | undefined;

  const settle = (): void => {
    if (!waiter || buffer.length < waiter.size) return;
    const { size, resolve } = waiter;
    waiter = undefined;
    const taken = Buffer.from(buffer.subarray(0, size));
    buffer = buffer.subarray(size);
    resolve(taken);
  };
  const fail = (error: Error): void => {
    failure ??= error;
    const pending = waiter;
    waiter = undefined;
    pending?.reject(failure);
  };

  const onData = (chunk: Buffer): void => {
    buffer = Buffer.concat([buffer, chunk]);
    settle();
  };
  const onError = (error: Error): void => fail(error);
  const onClose = (): void => fail(new Error("代理连接已关闭"));

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  return {
    read(size: number): Promise<Buffer> {
      if (failure) return Promise.reject(failure);
      return new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter = undefined;
          reject(new Error("代理握手超时"));
        }, HANDSHAKE_TIMEOUT_MS);
        timer.unref?.();
        waiter = {
          size,
          resolve: (chunk) => {
            clearTimeout(timer);
            resolve(chunk);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        settle();
      });
    },
    detach(): Buffer {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      return buffer;
    },
  };
}

async function handshakeSocks5(
  reader: Reader,
  socket: Socket,
  proxy: SshProxyEndpoint,
  target: SshTunnelEndpoint,
): Promise<void> {
  const useAuth = proxy.username !== undefined;
  socket.write(Buffer.from([0x05, useAuth ? 2 : 1, 0x00, ...(useAuth ? [0x02] : [])]));
  const [version, method] = await reader.read(2);
  if (version !== 0x05) throw new Error(`SOCKS5 代理返回了非预期版本 ${version}`);
  if (method === 0x02) {
    if (!useAuth) throw new Error("SOCKS5 代理要求认证，但没有配置用户名");
    const user = Buffer.from(proxy.username!, "utf8");
    const password = Buffer.from(proxy.password ?? "", "utf8");
    socket.write(
      Buffer.concat([
        Buffer.from([0x01, user.length]),
        user,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const [, status] = await reader.read(2);
    if (status !== 0x00) throw new Error("SOCKS5 代理拒绝了用户名或密码");
  } else if (method !== 0x00) {
    throw new Error("SOCKS5 代理拒绝了所有认证方式");
  }

  // ATYP=0x03 让代理解析域名：国外主机常常只有代理侧能完成 DNS。
  const host = Buffer.from(target.host, "utf8");
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));

  const head = await reader.read(4);
  if (head[1] !== 0x00) throw new Error(`SOCKS5 代理拒绝连接目标（错误码 ${head[1]}）`);
  if (head[3] === 0x01) {
    await reader.read(4 + 2);
  } else if (head[3] === 0x03) {
    const length = (await reader.read(1))[0] ?? 0;
    await reader.read(length + 2);
  } else {
    await reader.read(16 + 2);
  }
}

async function handshakeHttp(
  reader: Reader,
  socket: Socket,
  proxy: SshProxyEndpoint,
  target: SshTunnelEndpoint,
): Promise<void> {
  const authority = `${target.host}:${target.port}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.username !== undefined) {
    const credentials = Buffer.from(`${proxy.username}:${proxy.password ?? ""}`, "utf8");
    lines.push(`Proxy-Authorization: Basic ${credentials.toString("base64")}`);
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);

  // 逐字节读到空行：响应头之后紧跟的就是 SSH banner，多读的字节必须留在 buffer 里。
  const bytes: number[] = [];
  for (;;) {
    const byte = (await reader.read(1))[0] ?? 0;
    bytes.push(byte);
    const n = bytes.length;
    if (
      n >= 4 &&
      bytes[n - 4] === 13 &&
      bytes[n - 3] === 10 &&
      bytes[n - 2] === 13 &&
      bytes[n - 1] === 10
    ) {
      break;
    }
  }
  const text = Buffer.from(bytes).toString("latin1");
  const status = /^HTTP\/\d\.\d (\d{3})/u.exec(text);
  if (!status || Number(status[1]) < 200 || Number(status[1]) > 299) {
    const head = text.split("\r\n")[0] || "无响应";
    throw new Error(`HTTP 代理拒绝建立隧道：${head}`);
  }
}

async function openTunnel(
  proxy: SshProxyEndpoint,
  target: SshTunnelEndpoint,
): Promise<{ socket: Socket; rest: Buffer; reader: Reader }> {
  const socket = connectSocket({ host: proxy.host, port: proxyPort(proxy) });
  const reader = createReader(socket);
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接代理超时")), HANDSHAKE_TIMEOUT_MS);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    if (proxy.kind === "socks5") await handshakeSocks5(reader, socket, proxy, target);
    else await handshakeHttp(reader, socket, proxy, target);
    return { socket, reader, rest: reader.detach() };
  } catch (error) {
    reader.detach();
    socket.destroy();
    throw error;
  }
}

/** 代理端口缺省按协议取常用值，向导里不填端口时也不用报错。 */
function proxyPort(proxy: SshProxyEndpoint): number {
  return proxy.port ?? (proxy.kind === "socks5" ? 1080 : 8080);
}

function forwarderKey(proxy: SshProxyEndpoint, target: SshTunnelEndpoint): string {
  return JSON.stringify([
    "ssh-proxy:v1",
    proxy.kind,
    proxy.host.toLowerCase(),
    proxyPort(proxy),
    proxy.username ?? "",
    target.host.toLowerCase(),
    target.port,
  ]);
}

function ensureSweep(): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of forwarders) {
      void entry.then((forwarder) => {
        if (forwarder.active > 0 || now - forwarder.lastUsed < FORWARDER_IDLE_MS) return;
        forwarders.delete(key);
        forwarder.server.close();
      });
    }
  }, SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

async function startForwarder(
  proxy: SshProxyEndpoint,
  target: SshTunnelEndpoint,
): Promise<Forwarder> {
  const forwarder: Forwarder = {
    endpoint: { host: "127.0.0.1", port: 0 },
    // server 在 listen 之后回填。
    server: undefined as unknown as Server,
    lastUsed: Date.now(),
    active: 0,
  };
  const server = createServer((inbound) => {
    forwarder.lastUsed = Date.now();
    forwarder.active += 1;
    let closed = false;
    const release = (): void => {
      if (closed) return;
      closed = true;
      forwarder.active -= 1;
      forwarder.lastUsed = Date.now();
    };

    void (async () => {
      let tunnel: { socket: Socket; rest: Buffer };
      try {
        tunnel = await openTunnel(proxy, target);
      } catch (error) {
        lastTunnelError = error instanceof Error ? error.message : String(error);
        release();
        inbound.destroy();
        return;
      }
      const outbound = tunnel.socket;
      lastTunnelError = undefined;
      const shutdown = (): void => {
        inbound.destroy();
        outbound.destroy();
      };
      inbound.on("error", shutdown);
      outbound.on("error", shutdown);
      inbound.on("close", () => {
        release();
        outbound.destroy();
      });
      outbound.on("close", () => {
        release();
        inbound.destroy();
      });
      if (tunnel.rest.length > 0) outbound.unshift(tunnel.rest);
      inbound.pipe(outbound).pipe(inbound);
    })();
  });
  forwarder.server = server;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("代理转发器未能绑定本地端口");
  }
  forwarder.endpoint = { host: "127.0.0.1", port: address.port };
  return forwarder;
}

/**
 * 取（必要时创建）一台主机对应的本地转发端口。
 *
 * 同一 `target + proxy` 复用同一个 listener：ssh 每次调用都会新建连接，
 * 但隧道端点保持不变，避免每条命令都开一个新端口。
 */
export async function ensureSshProxyForwarder(
  proxy: SshProxyEndpoint,
  target: SshTunnelEndpoint,
): Promise<SshTunnelEndpoint> {
  const key = forwarderKey(proxy, target);
  const existing = forwarders.get(key);
  if (existing) {
    const forwarder = await existing;
    forwarder.lastUsed = Date.now();
    return forwarder.endpoint;
  }
  const created = startForwarder(proxy, target);
  forwarders.set(key, created);
  try {
    return (await created).endpoint;
  } catch (error) {
    forwarders.delete(key);
    throw error;
  }
}

/** 进程退出/工作区关闭时释放全部本地端口。 */
export function disposeSshProxyForwarders(): void {
  for (const entry of forwarders.values()) {
    void entry.then((forwarder) => forwarder.server.close()).catch(() => undefined);
  }
  forwarders.clear();
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = undefined;
  }
}
