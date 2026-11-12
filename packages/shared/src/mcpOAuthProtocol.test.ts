import { describe, expect, it } from "vitest";
import { convertToZCodeAgentMcpServer, type McpServerConfig } from "./mcp.js";
import { zcodeProtocolMcpServerSchema } from "./picode-protocol/index.js";

function httpConfig(oauth: McpServerConfig["oauth"]): McpServerConfig {
  return { type: "http", url: "https://example.invalid/mcp", oauth } as McpServerConfig;
}

describe("MCP oauth clientRegistration", () => {
  it("keeps Pi 1.5's clientRegistration in the protocol DTO instead of failing strict parsing", () => {
    // Pi 1.5.0 起 mcp.json 的 oauth 可带 clientRegistration（auto/dcr/cimd）。
    // 协议 schema 是 .strict() 的：漏掉这个键会让 mcp/list 与 session/create 直接
    // Invalid params，且嵌套未知键不会进入兼容降级重试。
    const dto = convertToZCodeAgentMcpServer(
      "probe",
      httpConfig({
        type: "authorization_code",
        clientName: "PiCode probe",
        clientRegistration: "auto",
      }),
    );
    const parsed = zcodeProtocolMcpServerSchema.safeParse(dto);
    expect(parsed.success).toBe(true);
    if (!parsed.success || !("oauth" in parsed.data))
      throw new Error("expected an http server DTO");
    expect(parsed.data.oauth).toEqual({
      type: "authorization_code",
      clientName: "PiCode probe",
      clientRegistration: "auto",
    });
  });

  it("accepts every registration mode Pi understands", () => {
    for (const mode of ["auto", "dcr", "cimd"] as const) {
      const dto = convertToZCodeAgentMcpServer(
        "probe",
        httpConfig({ type: "authorization_code", clientRegistration: mode }),
      );
      expect(zcodeProtocolMcpServerSchema.safeParse(dto).success).toBe(true);
    }
  });

  it("still rejects an unknown registration mode", () => {
    const dto = convertToZCodeAgentMcpServer(
      "probe",
      httpConfig({ type: "authorization_code", clientRegistration: "manual" as never }),
    );
    expect(zcodeProtocolMcpServerSchema.safeParse(dto).success).toBe(false);
  });
});
