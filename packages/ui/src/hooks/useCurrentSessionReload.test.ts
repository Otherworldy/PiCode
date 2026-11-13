import { describe, expect, it, vi } from "vitest";
import type { IZCodeAgentService } from "@picode/services";
import { commandEnvelopeSchema, V4_WIRE_PROTOCOL_VERSION } from "@picode/shared/picode-protocol-v4";
import { reloadCurrentSessionResources } from "./useCurrentSessionReload.js";

function serviceWithAck(ack: Record<string, unknown>) {
  const initialize = vi.fn(
    async (_params: Parameters<IZCodeAgentService["initializeConversationV4"]>[0]) => undefined,
  );
  const send = vi.fn(
    async (_params: Parameters<IZCodeAgentService["sendConversationCommandV4"]>[0]) => ({
      commandId: "ack",
      revisionAtDecision: 0,
      ...ack,
    }),
  );
  const service = {
    helloConversationV4: vi.fn(async () => ({
      kind: "hello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      connectionId: "connection",
      clientMode: "web-remote-replayable",
      deliveryProfile: "replayable",
      serverTime: 1,
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: false,
        compression: "none",
      },
      auth: {},
    })),
    initializeConversationV4: initialize,
    sendConversationCommandV4: send,
  } as unknown as IZCodeAgentService;
  return { service, initialize, send };
}

const target = {
  workspacePath: "/same/path",
  workspaceIdentity: "remote-workspace",
  sessionId: "current-session",
};

describe("current session reload command", () => {
  it("uses a strict empty payload, no CAS, and the handshake client id on the scoped service", async () => {
    const { service, send, initialize } = serviceWithAck({
      status: "accepted",
      result: { type: "reloadSession", slashCommands: [] },
    });
    expect(await reloadCurrentSessionResources({ ...target, agentService: service })).toEqual([]);
    const call = send.mock.calls[0]![0];
    expect(call).toMatchObject({
      workspacePath: target.workspacePath,
      workspaceIdentity: target.workspaceIdentity,
    });
    expect(commandEnvelopeSchema.parse(call.envelope)).toMatchObject({
      type: "reloadSession",
      sessionId: target.sessionId,
      payload: {},
      clientId: initialize.mock.calls[0]![0].clientId,
    });
    expect(call.envelope).not.toHaveProperty("baseRevision");
    expect(call.envelope).not.toHaveProperty("baseLogEpoch");
  });

  it.each([
    {
      status: "failed",
      message: "extension initialization failed",
      reasonCode: "fault.command.sessionReloadFailed",
    },
    { status: "rejected", reasonCode: "guard.sessionReloadBusy" },
    { status: "noop", reasonCode: "not-completed" },
    { status: "accepted" },
    { status: "duplicate" },
  ])("does not treat incomplete/failed ACK as success: $status", async (ack) => {
    const { service } = serviceWithAck(ack);
    await expect(
      reloadCurrentSessionResources({ ...target, agentService: service }),
    ).rejects.toThrow(ack.message ?? ack.reasonCode ?? ack.status);
  });

  it("retains the busy reason code when the Host also provides a diagnostic message", async () => {
    const { service } = serviceWithAck({
      status: "failed",
      reasonCode: "guard.sessionReloadBusy",
      message: "The session has pending interactions.",
    });
    await expect(
      reloadCurrentSessionResources({ ...target, agentService: service }),
    ).rejects.toMatchObject({
      message: "The session has pending interactions.",
      reasonCode: "guard.sessionReloadBusy",
    });
  });

  it("accepts a completed duplicate and gives each explicit retry a new command id", async () => {
    const { service, send } = serviceWithAck({
      status: "duplicate",
      result: { type: "reloadSession", slashCommands: [] },
    });
    await reloadCurrentSessionResources({ ...target, agentService: service });
    await reloadCurrentSessionResources({ ...target, agentService: service });
    expect(send.mock.calls[0]![0].envelope.commandId).not.toBe(
      send.mock.calls[1]![0].envelope.commandId,
    );
  });
});
