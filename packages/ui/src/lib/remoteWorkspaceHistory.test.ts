import { describe, expect, it } from "vitest";
import {
  buildRemoteWorkspaceSessionMutation,
  createRemoteTargetFromSnapshot,
} from "./remoteWorkspaceHistory.js";

const emptyPasswordTarget = {
  kind: "ssh",
  host: "192.168.87.20",
  username: "user",
  password: "",
} as const;

describe("empty SSH password in workspace history", () => {
  it("persists an empty password under a credential key", () => {
    // 无密码账户的空口令也要进 credentialService：
    // 用 truthiness 判断会既不生成 key 也不写凭据，重启后重连就变成「没有密码」。
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [],
      workspacePath: "/srv/app",
      target: emptyPasswordTarget,
      lastConnectionStatus: "connected",
      touchOpenedAt: false,
    });

    const snapshot = mutation.entry.target;
    expect(snapshot.kind).toBe("ssh");
    const credentialKey = snapshot.kind === "ssh" ? snapshot.passwordCredentialKey : undefined;
    expect(credentialKey).toBeTruthy();
    expect(mutation.credentialsToSave).toEqual([{ key: credentialKey, value: "" }]);
  });

  it("restores an empty password instead of dropping it", () => {
    const restored = createRemoteTargetFromSnapshot(
      { kind: "ssh", host: "192.168.87.20", username: "user", passwordCredentialKey: "k" },
      { password: "", privateKeyPassphrase: null },
    );

    expect(restored).toMatchObject({ kind: "ssh", password: "" });
  });

  it("still omits the password when no credential was stored", () => {
    const restored = createRemoteTargetFromSnapshot(
      { kind: "ssh", host: "192.168.87.20", username: "user" },
      { password: null, privateKeyPassphrase: null },
    );

    expect(restored).not.toHaveProperty("password");
  });
});

describe("SSH proxy in workspace history", () => {
  const proxiedTarget = {
    kind: "ssh",
    host: "82.118.28.109",
    port: 49615,
    username: "root",
    proxy: { kind: "socks5", host: "127.0.0.1", port: 7897, username: "alice", password: "pw" },
  } as const;

  it("stores the proxy endpoint without its password", () => {
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [],
      workspacePath: "/root",
      target: proxiedTarget,
      lastConnectionStatus: "connected",
      touchOpenedAt: false,
    });

    const snapshot = mutation.entry.target;
    expect(snapshot.kind === "ssh" ? snapshot.proxy : undefined).toEqual({
      kind: "socks5",
      host: "127.0.0.1",
      port: 7897,
      username: "alice",
    });
    expect(JSON.stringify(mutation.entry)).not.toContain("pw");
  });

  it("saves the proxy password under its own credential key", () => {
    const mutation = buildRemoteWorkspaceSessionMutation({
      remoteSessions: [],
      workspacePath: "/root",
      target: proxiedTarget,
      lastConnectionStatus: "connected",
      touchOpenedAt: false,
    });

    const snapshot = mutation.entry.target;
    const key = snapshot.kind === "ssh" ? snapshot.proxyPasswordCredentialKey : undefined;
    expect(key).toBeTruthy();
    expect(mutation.credentialsToSave).toContainEqual({ key, value: "pw" });
  });

  it("restores the proxy with the stored password", () => {
    const restored = createRemoteTargetFromSnapshot(
      {
        kind: "ssh",
        host: "82.118.28.109",
        port: 49615,
        username: "root",
        proxy: { kind: "http", host: "proxy.local", port: 8080 },
        proxyPasswordCredentialKey: "k",
      },
      { password: null, privateKeyPassphrase: null, proxyPassword: "pw" },
    );

    expect(restored).toMatchObject({
      proxy: { kind: "http", host: "proxy.local", port: 8080, password: "pw" },
    });
  });
});
