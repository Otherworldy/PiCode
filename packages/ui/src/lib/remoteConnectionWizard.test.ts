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
