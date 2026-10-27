import { afterEach, describe, expect, it } from "vitest";
import { buildSSHConnectConfig, createKeyboardInteractiveResponder } from "./sshAuth.js";

const base = { host: "192.168.87.20", username: "user" };

describe("buildSSHConnectConfig", () => {
  const originalAuthSock = process.env["SSH_AUTH_SOCK"];

  afterEach(() => {
    if (originalAuthSock === undefined) {
      delete process.env["SSH_AUTH_SOCK"];
    } else {
      process.env["SSH_AUTH_SOCK"] = originalAuthSock;
    }
  });

  it("treats an empty password as password auth and skips the implicit agent", () => {
    // 空口令账户：密码字段必须是 ""（ssh2 用 typeof 判定），并且不能退回 SSH_AUTH_SOCK
    // 的公钥尝试——部分主机 MaxAuthTries 很小，公钥阶段就会把次数耗尽。
    process.env["SSH_AUTH_SOCK"] = "/tmp/agent.sock";

    const config = buildSSHConnectConfig({ ...base, password: "" });

    expect(config.password).toBe("");
    expect(config.tryKeyboard).toBe(true);
    expect(config.agent).toBeUndefined();
  });

  it("keeps agent auth available when no password is provided", () => {
    process.env["SSH_AUTH_SOCK"] = "/tmp/agent.sock";

    const config = buildSSHConnectConfig({ ...base });

    expect(config.password).toBeUndefined();
    expect(config.tryKeyboard).toBe(false);
    expect(config.agent).toBe("/tmp/agent.sock");
  });
});

describe("createKeyboardInteractiveResponder", () => {
  it("answers prompts with an empty password instead of skipping them", () => {
    let responses: string[] | undefined;

    createKeyboardInteractiveResponder("")(
      "Keyboard Interactive",
      "",
      "",
      [{ prompt: "Password: ", echo: false }],
      (value) => {
        responses = value;
      },
    );

    expect(responses).toEqual([""]);
  });

  it("skips prompts when no password auth is configured", () => {
    let responses: string[] | undefined;

    createKeyboardInteractiveResponder(undefined)(
      "Keyboard Interactive",
      "",
      "",
      [{ prompt: "Password: ", echo: false }],
      (value) => {
        responses = value;
      },
    );

    expect(responses).toEqual([]);
  });
});
