import { describe, expect, it } from "vitest";
import { builtinProviderConfigRulesSchema } from "./rule-data-schema.js";
import { zhipuAccountModeDataSchema } from "./provider-data-schema.js";

function accountRule(providerId: string, mode: string, accountType: "zai" | "bigmodel") {
  return {
    providerId,
    providerName: providerId,
    config: {
      group: accountType === "zai" ? "zai-family" : "bigmodel-family",
      builtinModelIds: ["GLM-5.3"],
      visibility: "hidden",
      access: { type: "zhipu-account", mode, accountType },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://zcode.z.ai/api/v1/highspeed/anthropic",
      },
      logo: { type: "builtin", key: accountType },
    },
  };
}

describe("zhipu account mode", () => {
  it("accepts the highspeed card mode shipped by remote revision 43", () => {
    // 远端 revision 43 的 providerRules[8]/[9] 是 highspeed 派生 Provider。
    // 不认识这个 mode 会让整份 Release 校验失败，所有用户回落到 bundled 配置。
    expect(zhipuAccountModeDataSchema.safeParse("highspeed").success).toBe(true);
  });

  it("keeps every mode remote config may send", () => {
    for (const mode of ["start-plan", "individual-coding-plan", "team-coding-plan", "off-peak"]) {
      expect(zhipuAccountModeDataSchema.safeParse(mode).success).toBe(true);
    }
  });

  it("still rejects an unknown mode", () => {
    expect(zhipuAccountModeDataSchema.safeParse("ultra-plan").success).toBe(false);
  });

  it("parses a release-shaped providerRules list containing highspeed providers", () => {
    const parsed = builtinProviderConfigRulesSchema.safeParse({
      templateRules: [],
      providerRules: [
        accountRule("account:zai-highspeed-card", "highspeed", "zai"),
        accountRule("account:bigmodel-highspeed-card", "highspeed", "bigmodel"),
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
