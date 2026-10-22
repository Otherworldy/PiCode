import { describe, expect, it } from "vitest";
import { parseBuiltInSubagentToolOverrides } from "./subagents-types.js";

describe("parseBuiltInSubagentToolOverrides", () => {
  it("keeps known roles and trims tool names", () => {
    expect(
      parseBuiltInSubagentToolOverrides({
        researcher: { tools: [" read ", "one_search", "read"] },
        worker: { tools: ["bash"], excludeTools: ["bash"] },
      }),
    ).toEqual({
      researcher: { tools: ["read", "one_search"] },
      worker: { tools: ["bash"], excludeTools: ["bash"] },
    });
  });

  it("accepts the legacy bare array form", () => {
    expect(parseBuiltInSubagentToolOverrides({ researcher: ["read", "one_search"] })).toEqual({
      researcher: { tools: ["read", "one_search"] },
    });
  });

  it("keeps an explicit empty list as no tools and inherit as a value", () => {
    expect(parseBuiltInSubagentToolOverrides({ researcher: { tools: [] } })).toEqual({
      researcher: { tools: [] },
    });
    expect(parseBuiltInSubagentToolOverrides({ scout: { tools: "inherit" } })).toEqual({
      scout: { tools: "inherit" },
    });
  });

  it("drops unknown roles, empty entries and non-string values", () => {
    expect(
      parseBuiltInSubagentToolOverrides({
        "general-purpose": ["read"],
        researcher: {},
        scout: { tools: ["read", 3, "", "  "] },
        worker: "bash",
      }),
    ).toEqual({ scout: { tools: ["read"] } });
  });

  it("treats a missing or broken value as no override", () => {
    expect(parseBuiltInSubagentToolOverrides(undefined)).toEqual({});
    expect(parseBuiltInSubagentToolOverrides([])).toEqual({});
    expect(parseBuiltInSubagentToolOverrides("researcher")).toEqual({});
  });
});
