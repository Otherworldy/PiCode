import { describe, expect, it, vi } from "vitest";
import { parseZCodeBuiltinProviderConfigMap } from "@zcode/provider";
import {
  createAccountProviderConnectionResolver,
  type AccountProviderFamilyAvailabilityInput,
} from "./accountProviderConnectionResolver.js";

function accountRule(providerId: string, mode: string, accountType: "zai" | "bigmodel") {
  return {
    providerId,
    providerName: providerId,
    config: {
      group: accountType === "zai" ? "zai-family" : "bigmodel-family",
      builtinModelIds: ["GLM-5.3"],
      ...(mode === "highspeed" || mode === "off-peak" ? { visibility: "hidden" } : {}),
      access: { type: "zhipu-account", mode, accountType },
      api: {
        type: "anthropic-messages",
        baseUrl: `https://zcode.z.ai/api/v1/${mode}/anthropic`,
      },
      logo: { type: "builtin", key: accountType },
    },
  };
}

const settings = {
  providerFamilyDomain: "zai" as const,
  selections: {},
};

describe("account provider connection resolver", () => {
  it("never queries coding-plan availability for derived proxy modes", async () => {
    // off-peak / highspeed 是 hidden 派生代理 Provider，可用性由所依附的真实套餐推导。
    // 把它们的 mode 当 planKind 去查订阅接口会拿到错的权益，也拿不到 apiKey。
    const resolveFamilyAvailability = vi.fn(
      async (_input: AccountProviderFamilyAvailabilityInput) => ({}),
    );
    const loadCodingPlanApiKey = vi.fn(async () => null);
    const resolver = createAccountProviderConnectionResolver({
      readSettings: async () => settings,
      loadAccountIdentity: async () => "account-1",
      loadCodingPlanApiKey,
      resolveFamilyAvailability,
    });

    const configuredProviders = parseZCodeBuiltinProviderConfigMap([
      accountRule("account:zai-individual-coding-plan", "individual-coding-plan", "zai"),
      accountRule("account:zai-offpeak-idle-plan", "off-peak", "zai"),
      accountRule("account:zai-highspeed-card", "highspeed", "zai"),
    ]);

    await resolver({ configRevision: "rev-1", configuredProviders, reasons: [] });

    const queried = resolveFamilyAvailability.mock.calls.flatMap(([input]) =>
      input.providers.map((provider) => `${provider.providerId}:${provider.planKind}`),
    );
    expect(queried).toEqual(["account:zai-individual-coding-plan:individual-coding-plan"]);
  });
});
