import assert from "node:assert/strict";
import test from "node:test";
import { installCliProcessErrorBoundary } from "./process-errors.js";

test("stale extension context rejection does not shut down the process", () => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const lines: string[] = [];
  let fatal = 0;
  const dispose = installCliProcessErrorBoundary({
    target: {
      on(event, listener) {
        listeners.set(event, listener as (...args: unknown[]) => void);
      },
      off(event) {
        listeners.delete(event);
      },
    },
    stderr: {
      write(chunk) {
        lines.push(chunk);
      },
    },
    onFatal() {
      fatal += 1;
    },
  });
  listeners.get("unhandledRejection")?.(
    new Error(
      "This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx.",
    ),
  );
  listeners.get("unhandledRejection")?.(new Error("boom"));
  dispose();
  assert.equal(fatal, 1);
  assert.match(lines.join("\n"), /ignored stale extension context/);
});
