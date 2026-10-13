import type { NetworkInterfaceInfo } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HostMessageTypes } from "@zcode/shared";
import { join } from "node:path";
import {
  createMobileRemotePairingController,
  mobileRemoteWebRootCandidates,
  selectLanIPv4,
  type MobileRemoteHostPort,
} from "./mobileRemotePairing.js";

const controllers: Array<{ stopAll(): void }> = [];

afterEach(() => {
  for (const controller of controllers) controller.stopAll();
  controllers.length = 0;
});

function ipv4(address: string, internal = false): NetworkInterfaceInfo {
  return {
    address,
    family: "IPv4",
    internal,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: null,
  };
}

function fakePort() {
  return {
    addEventListener() {},
    removeEventListener() {},
    postMessage() {},
    start() {},
    close() {},
  };
}

function opened(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

describe("selectLanIPv4", () => {
  it("skips loopback and link-local addresses", () => {
    expect(
      selectLanIPv4({
        lo: [ipv4("127.0.0.1", true)],
        link: [ipv4("169.254.1.1")],
        lan: [ipv4("192.168.1.20")],
      }),
    ).toBe("192.168.1.20");
  });

  it("returns null when the machine has no LAN address", () => {
    expect(selectLanIPv4({ lo: [ipv4("127.0.0.1", true)] })).toBeNull();
  });
});

describe("mobile remote web root", () => {
  it("reads the packaged page before the repository dist", () => {
    expect(
      mobileRemoteWebRootCandidates({
        override: "override",
        packagedRoot: join("resources", "mobile-web"),
        appPath: "app.asar",
      }),
    ).toEqual([
      "override",
      join("resources", "mobile-web"),
      join("app.asar", "../web/dist"),
      join("app.asar", "web-dist"),
    ]);
  });

  it("does not invent a packaged directory for a development app", () => {
    expect(
      mobileRemoteWebRootCandidates({
        appPath: join("packages", "desktop"),
      }),
    ).toEqual([
      join("packages", "desktop", "../web/dist"),
      join("packages", "desktop", "web-dist"),
    ]);
  });
});

describe("mobile remote pairing", () => {
  it("rejects the old token after disconnect and does not spawn another host", async () => {
    const host: MobileRemoteHostPort & { messages: unknown[] } = {
      messages: [],
      postMessage(message) {
        this.messages.push(message);
      },
    };
    const hosts = new Set<MobileRemoteHostPort>();
    const remoteAttaches: Array<{ clientMode: string }> = [];
    const unavailable = createMobileRemotePairingController({
      logger: { info() {}, warn() {} },
      selectAddress: () => null,
      listenHost: "127.0.0.1",
      getHost: () => host,
      attachRemote: () => {
        throw new Error("should not attach");
      },
      createChannel: () => ({ port1: fakePort(), port2: {} }),
      resolveWindow: () => ({ id: 7, webContentsId: 8, onClosed() {} }),
    });
    controllers.push(unavailable);
    expect(await unavailable.start(7)).toEqual({ status: "unavailable", reason: "no-lan-address" });

    const firewallPorts: number[] = [];
    const ready = createMobileRemotePairingController({
      logger: { info() {}, warn() {} },
      selectAddress: () => "192.168.1.20",
      listenHost: "127.0.0.1",
      ensureFirewall: async (port) => {
        firewallPorts.push(port);
        return "allowed";
      },
      getHost() {
        hosts.add(host);
        return host;
      },
      attachRemote(params) {
        remoteAttaches.push(params);
        return { port: fakePort(), attachmentId: "remote-attachment" };
      },
      createChannel: () => ({ port1: fakePort(), port2: { transferred: true } }),
      resolveWindow: () => ({ id: 7, webContentsId: 8, onClosed() {} }),
    });
    controllers.push(ready);
    ready.setCatalog(7, [
      { workspacePath: "D:/local", label: "local" },
      {
        workspacePath: "/remote/repo",
        workspaceIdentity: "ssh://example/repo",
        remoteSessionId: "session-1",
        label: "remote",
      },
    ]);
    const started = await ready.start(7);
    expect(started.status).toBe("ready");
    if (started.status !== "ready") return;
    const url = new URL(started.url);
    expect(url.hostname).toBe("192.168.1.20");
    expect(url.hostname).not.toBe("127.0.0.1");
    expect(firewallPorts).toEqual([Number(url.port)]);
    expect(await ready.start(7)).toMatchObject({ status: "ready", firewall: "allowed" });
    expect(firewallPorts).toEqual([Number(url.port), Number(url.port)]);
    const token = url.searchParams.get("pair");
    expect(token).toBeTruthy();
    const endpoint = `http://127.0.0.1:${url.port}`;
    const listed = await fetch(`${endpoint}/api/mobile-remote/workspaces?pair=${token}`);
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as {
      workspaces: Array<{ workspaceKey: string; remoteSessionId?: string }>;
    };
    expect(body.workspaces.map((item) => item.workspaceKey)).toEqual([
      "D:/local",
      "ssh://example/repo",
    ]);

    const first = new WebSocket(
      `ws://127.0.0.1:${url.port}/ws?pair=${encodeURIComponent(token ?? "")}&workspaceKey=${encodeURIComponent("D:/local")}`,
    );
    await opened(first);
    const attaches = () =>
      host.messages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { type?: string }).type === HostMessageTypes.AttachServicePort,
      );
    expect(attaches()).toHaveLength(1);
    expect(attaches()[0]).toMatchObject({
      clientMode: "web-remote-replayable",
      scope: { kind: "local" },
    });

    const second = new WebSocket(
      `ws://127.0.0.1:${url.port}/ws?pair=${encodeURIComponent(token ?? "")}&workspaceKey=${encodeURIComponent("ssh://example/repo")}`,
    );
    await opened(second);
    await new Promise((resolve) => first.once("close", resolve));
    expect(remoteAttaches).toEqual([
      expect.objectContaining({
        clientMode: "web-remote-replayable",
        remoteSessionId: "session-1",
        workspaceKey: "ssh://example/repo",
      }),
    ]);
    expect(hosts.size).toBe(1);
    expect(
      host.messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          (message as { type?: string }).type === HostMessageTypes.DetachServicePort,
      ),
    ).toBe(true);

    await ready.stop(7);
    const rejected = await fetch(`${endpoint}/api/mobile-remote/workspaces?pair=${token}`).catch(
      () => null,
    );
    expect(rejected == null || rejected.status === 401).toBe(true);
    second.close();
  });
});
