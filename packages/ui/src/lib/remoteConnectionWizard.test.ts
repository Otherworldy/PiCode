import { describe, expect, it } from "vitest";
import { buildRemoteTarget } from "./remoteConnectionWizard.js";

const intl = { formatMessage: ({ id }: { id: string }) => id };

function snapshot(overrides: Record<string, unknown>) {
  return {
    kind: "ssh",
    host: "192.168.87.20",
    port: "22",
    username: "user",
    sshAuthMethod: "password",
    password: "",
    proxyKind: "",
    proxyHost: "",
    proxyPort: "",
    proxyUsername: "",
    proxyPassword: "",
    privateKeyPath: "",
    privateKeyPassphrase: "",
    wslDistro: "",
    dockerContainer: "",
    manualDockerContainer: "",
    ...overrides,
  } as Parameters<typeof buildRemoteTarget>[1];
}

describe("buildRemoteTarget", () => {
  it("accepts an empty password as password auth instead of rejecting the form", () => {
    // 无密码账户的虚拟机只能用空口令登录：空字符串必须原样进 target，
    // 否则下游会当成「没选密码认证」退回公钥认证。
    const { target, errorMessage } = buildRemoteTarget(intl, snapshot({}));

    expect(errorMessage).toBeUndefined();
    expect(target).toMatchObject({ kind: "ssh", password: "" });
  });

  it("keeps a non-empty password unchanged", () => {
    const { target } = buildRemoteTarget(intl, snapshot({ password: "s3cret" }));

    expect(target).toMatchObject({ kind: "ssh", password: "s3cret" });
  });

  it("still requires host and username", () => {
    const { target, errorMessage } = buildRemoteTarget(intl, snapshot({ host: "" }));

    expect(target).toBeUndefined();
    expect(errorMessage).toBe("ssh.validation.required");
  });

  it("still requires a private key path in private key mode", () => {
    const { target, errorMessage } = buildRemoteTarget(
      intl,
      snapshot({ sshAuthMethod: "privateKey" }),
    );

    expect(target).toBeUndefined();
    expect(errorMessage).toBe("ssh.validation.privateKeyRequired");
  });
});

describe("SSH proxy in the connection wizard", () => {
  it("omits the proxy field when no proxy kind is selected", () => {
    const { target } = buildRemoteTarget(intl, snapshot({}));

    expect(target).not.toHaveProperty("proxy");
  });

  it("keeps the proxy endpoint and its credentials on the target", () => {
    const { target, errorMessage } = buildRemoteTarget(
      intl,
      snapshot({
        proxyKind: "socks5",
        proxyHost: " 127.0.0.1 ",
        proxyPort: "7897",
        proxyUsername: "alice",
        proxyPassword: "s3cret",
      }),
    );

    expect(errorMessage).toBeUndefined();
    expect(target).toMatchObject({
      proxy: {
        kind: "socks5",
        host: "127.0.0.1",
        port: 7897,
        username: "alice",
        password: "s3cret",
      },
    });
  });

  it("rejects a proxy without a host", () => {
    const { target, errorMessage } = buildRemoteTarget(
      intl,
      snapshot({ proxyKind: "http", proxyHost: "  " }),
    );

    expect(target).toBeUndefined();
    expect(errorMessage).toBe("ssh.validation.proxyHostRequired");
  });

  it("rejects an out-of-range proxy port", () => {
    const { target, errorMessage } = buildRemoteTarget(
      intl,
      snapshot({ proxyKind: "http", proxyHost: "proxy.local", proxyPort: "70000" }),
    );

    expect(target).toBeUndefined();
    expect(errorMessage).toBe("ssh.validation.proxyPortInvalid");
  });
});
