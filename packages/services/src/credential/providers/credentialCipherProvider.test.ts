import { describe, expect, it } from "vitest";
import { createCredentialCipherProvider } from "./credentialCipherProvider.js";

const cipher = createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: "test-secret" } });

describe("createCredentialCipherProvider", () => {
  it("round-trips an empty password", () => {
    // 无密码账户的空口令也会写进 credentialService：
    // 空串密文的密文段为空，解密时不能按 truthiness 判成「密文格式非法」。
    const encrypted = cipher.encrypt("");

    expect(cipher.decrypt(encrypted)).toBe("");
  });

  it("round-trips a non-empty password", () => {
    expect(cipher.decrypt(cipher.encrypt("s3cret"))).toBe("s3cret");
  });

  it("rejects a malformed ciphertext", () => {
    expect(() => cipher.decrypt("enc:v1:only-one-part")).toThrow(/密文格式非法/u);
  });
});
