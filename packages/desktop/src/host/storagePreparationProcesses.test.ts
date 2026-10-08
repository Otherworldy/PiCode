import { describe, expect, it } from "vitest";
import {
  redactStorageWorkerDiagnostic,
  shouldRetrySessionStorageWorker,
} from "./storagePreparationProcesses.js";

describe("session storage worker retry", () => {
  it("retries a lost worker only before the database path is known", () => {
    expect(
      shouldRetrySessionStorageWorker({
        kind: "transport_closed",
        storageWorkerBeforePath: true,
      }),
    ).toBe(true);
    expect(
      shouldRetrySessionStorageWorker({
        kind: "transport_closed",
        storageWorkerBeforePath: false,
      }),
    ).toBe(false);
    expect(
      shouldRetrySessionStorageWorker({
        kind: "sql_failed",
        storageWorkerBeforePath: true,
      }),
    ).toBe(false);
    expect(shouldRetrySessionStorageWorker({ code: "EBUSY", storageWorkerBeforePath: true })).toBe(
      true,
    );
  });

  it("drops local paths from the worker diagnostic", () => {
    const text = redactStorageWorkerDiagnostic(
      "Error: Cannot read D:\\Programe\\PiCode\\resources\\glm\\zcode.cjs\n    at /Users/demo/app.js:1:1\n",
    );
    expect(text).not.toContain("PiCode");
    expect(text).not.toContain("/Users/demo");
    expect(text).toContain("[path]");
    expect(text).toContain("Cannot read");
  });
});
