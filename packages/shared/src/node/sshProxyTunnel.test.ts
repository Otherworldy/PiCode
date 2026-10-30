import { createServer, Socket, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  disposeSshProxyForwarders,
  ensureSshProxyForwarder,
  lastSshProxyTunnelError,
} from "./sshProxyTunnel.js";

/** 假代理：把隧道内的数据原样回显，够验证握手与双向桥。 */
function startProxy(handler: (socket: Socket) => void): Promise<{
  port: number;
  server: Server;
}> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ port: typeof address === "object" && address ? address.port : 0, server });
    });
  });
}

function socks5Server(options: { requireAuth?: { user: string; password: string } } = {}) {
  return startProxy((socket) => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0) {
        // greeting: ver, nmethods, methods...
        const methodCount = buffer[1] ?? 0;
        const methods = buffer.subarray(2, 2 + methodCount);
        buffer = buffer.subarray(2 + methodCount);
        if (options.requireAuth) {
          socket.write(Buffer.from([0x05, methods.includes(0x02) ? 0x02 : 0xff]));
        } else {
          socket.write(Buffer.from([0x05, methods.includes(0x00) ? 0x00 : 0xff]));
        }
        stage = 1;
      }
      if (stage === 1 && options.requireAuth && buffer.length > 1) {
        // auth: ver, ulen, user, plen, pass
        const ulen = buffer[1] ?? 0;
        const user = buffer.subarray(2, 2 + ulen).toString("utf8");
        const plen = buffer[2 + ulen] ?? 0;
        const password = buffer.subarray(3 + ulen, 3 + ulen + plen).toString("utf8");
        buffer = buffer.subarray(3 + ulen + plen);
        const ok = user === options.requireAuth.user && password === options.requireAuth.password;
        socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]));
        stage = ok ? 2 : 3;
      } else if (stage === 1 && !options.requireAuth) {
        stage = 2;
      }
      if (stage === 2 && buffer.length >= 5) {
        // CONNECT: ver, cmd, rsv, atyp, len, host..., port
        const atyp = buffer[3];
        const hostLength = atyp === 0x03 ? (buffer[4] ?? 0) : 0;
        const consumed = atyp === 0x03 ? 5 + hostLength + 2 : 10;
        if (buffer.length < consumed) return;
        const host =
          atyp === 0x03 ? buffer.subarray(5, 5 + hostLength).toString("utf8") : "127.0.0.1";
        buffer = buffer.subarray(consumed);
        // 回一个带域名的成功响应，顺带验证客户端能按 ATYP=3 跳过地址。
        const reply = Buffer.concat([
          Buffer.from([0x05, 0x00, 0x00, 0x03, host.length]),
          Buffer.from(host, "utf8"),
          Buffer.from([0x00, 0x16]),
        ]);
        socket.write(reply);
        stage = 4;
      }
      if (stage === 4 && buffer.length > 0) {
        socket.write(Buffer.concat([Buffer.from("echo:"), buffer]));
        buffer = Buffer.alloc(0);
      }
    });
  });
}

function httpServer(options: { auth?: string } = {}) {
  return startProxy((socket) => {
    let head = "";
    let tunneled = false;
    socket.on("data", (chunk: Buffer) => {
      if (tunneled) {
        socket.write(Buffer.concat([Buffer.from("echo:"), chunk]));
        return;
      }
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const authorized =
        options.auth === undefined ||
        head.includes(`Proxy-Authorization: Basic ${Buffer.from(options.auth).toString("base64")}`);
      socket.write(
        authorized
          ? "HTTP/1.1 200 Connection Established\r\n\r\n"
          : "HTTP/1.1 407 Proxy Authentication Required\r\n\r\n",
      );
      tunneled = authorized;
      head = "";
    });
  });
}

/** 通过隧道发一段数据并读回。 */
function roundTrip(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.connect(port, "127.0.0.1", () => socket.write(payload));
    socket.once("data", (chunk: Buffer) => {
      socket.destroy();
      resolve(chunk.toString("utf8"));
    });
    socket.once("error", reject);
    // 隧道握手失败时转发器直接销毁入站连接，只会给 close 不会给 error。
    socket.once("close", () => reject(new Error("tunnel closed")));
  });
}

const servers: Server[] = [];

afterEach(() => {
  disposeSshProxyForwarders();
  for (const server of servers.splice(0)) server.close();
});

describe("ensureSshProxyForwarder", () => {
  it("tunnels through a SOCKS5 proxy without authentication", async () => {
    const proxy = await socks5Server();
    servers.push(proxy.server);
    const endpoint = await ensureSshProxyForwarder(
      { kind: "socks5", host: "127.0.0.1", port: proxy.port },
      { host: "example.com", port: 22 },
    );
    expect(endpoint.host).toBe("127.0.0.1");
    await expect(roundTrip(endpoint.port, "ping")).resolves.toContain("echo:ping");
  });

  it("reuses one local listener per target and proxy", async () => {
    const proxy = await socks5Server();
    servers.push(proxy.server);
    const first = await ensureSshProxyForwarder(
      { kind: "socks5", host: "127.0.0.1", port: proxy.port },
      { host: "example.com", port: 22 },
    );
    const second = await ensureSshProxyForwarder(
      { kind: "socks5", host: "127.0.0.1", port: proxy.port },
      { host: "example.com", port: 22 },
    );
    expect(second.port).toBe(first.port);
  });

  it("sends SOCKS5 username and password when the proxy demands them", async () => {
    const proxy = await socks5Server({ requireAuth: { user: "alice", password: "s3cret" } });
    servers.push(proxy.server);
    const endpoint = await ensureSshProxyForwarder(
      {
        kind: "socks5",
        host: "127.0.0.1",
        port: proxy.port,
        username: "alice",
        password: "s3cret",
      },
      { host: "example.com", port: 22 },
    );
    await expect(roundTrip(endpoint.port, "ping")).resolves.toContain("echo:ping");
  });

  it("surfaces a rejected SOCKS5 password instead of hanging", async () => {
    const proxy = await socks5Server({ requireAuth: { user: "alice", password: "s3cret" } });
    servers.push(proxy.server);
    const endpoint = await ensureSshProxyForwarder(
      { kind: "socks5", host: "127.0.0.1", port: proxy.port, username: "alice", password: "wrong" },
      { host: "example.com", port: 22 },
    );
    await expect(roundTrip(endpoint.port, "ping")).rejects.toBeTruthy();
    expect(lastSshProxyTunnelError()).toMatch(/SOCKS5/u);
  });

  it("tunnels through an HTTP CONNECT proxy", async () => {
    const proxy = await httpServer();
    servers.push(proxy.server);
    const endpoint = await ensureSshProxyForwarder(
      { kind: "http", host: "127.0.0.1", port: proxy.port },
      { host: "example.com", port: 22 },
    );
    await expect(roundTrip(endpoint.port, "ping")).resolves.toContain("echo:ping");
  });

  it("sends Basic credentials to an HTTP proxy", async () => {
    const proxy = await httpServer({ auth: "bob:pass" });
    servers.push(proxy.server);
    const endpoint = await ensureSshProxyForwarder(
      { kind: "http", host: "127.0.0.1", port: proxy.port, username: "bob", password: "pass" },
      { host: "example.com", port: 22 },
    );
    await expect(roundTrip(endpoint.port, "ping")).resolves.toContain("echo:ping");
  });

  it("reports an HTTP proxy rejection", async () => {
    const proxy = await httpServer({ auth: "bob:pass" });
    servers.push(proxy.server);
    const endpoint = await ensureSshProxyForwarder(
      { kind: "http", host: "127.0.0.1", port: proxy.port },
      { host: "example.com", port: 22 },
    );
    await expect(roundTrip(endpoint.port, "ping")).rejects.toBeTruthy();
    expect(lastSshProxyTunnelError()).toMatch(/407/u);
  });
});
